/**
 * 播放队列：显式的「下一集」顺序，独立于视频流的随机顺序。
 *
 * 设计要点：
 *  1. 队列只由**目录自然序**生成 —— 刷到某部剧的任意一集，就从那一集开始
 *     按「第1集、第2集…第10集」连播（字典序会把 10 排到 2 前面，故用自然序）。
 *  2. 随机（shuffle）只是**播放顺序**的打乱，可见列表仍是目录序，
 *     且当前项永远置顶 —— 随机不打断正在播放的这一集。
 *  3. 循环三态：off（播完停） / all（整表循环） / one（单集重播）。
 *  4. 持久化在服务端（meta 表），刷新/重启/换浏览器都能接着连播；
 *     只存 id，读取时由服务端解析成当前存在的媒体，失效条目自动剔除。
 *  5. enabled=false 表示用户主动清空过队列 —— 此时不再自动生成，
 *     直到用户在队列面板里重新开启。
 */

import { api, debounce } from './utils.js';

const MODES = ['off', 'all', 'one'];
const MAX_PAGES = 20;          // 拉目录时最多翻 20 页（200 条/页），防异常目录死循环
const PAGE = 200;

export class PlayQueue {
    constructor() {
        this.ids = [];
        this.index = -1;
        this.mode = 'off';
        this.shuffle = false;
        this.enabled = true;
        this.origin = '';        // 生成队列的目录（展示用）
        this.items = new Map();  // id -> 媒体元数据
        this._playOrder = null;  // shuffle 时的播放顺序（惰性生成）
        this._save = debounce(() => this._persist(), 400);
        this._onChange = null;
    }

    /** 订阅变化（队列面板重绘）。 */
    onChange(fn) { this._onChange = fn; }

    _changed() {
        this._save();
        if (this._onChange) this._onChange();
    }

    /* ---------- 持久化 ---------- */

    async load() {
        try {
            const d = await api('/api/queue');
            const q = d.queue || {};
            this.ids = (q.ids || []).map(Number).filter(n => n > 0);
            this.index = Number.isInteger(q.index) ? q.index : -1;
            this.mode = MODES.includes(q.mode) ? q.mode : 'off';
            this.shuffle = !!q.shuffle;
            this.enabled = q.enabled !== false;
            this.origin = q.origin || '';
            this.items = new Map((q.items || []).map(m => [Number(m.id), m]));
            this._playOrder = null;
        } catch (e) {
            // 后端不可用时队列留空：自动生成仍能工作（拉到目录就重建）
        }
        if (this._onChange) this._onChange();
    }

    _persist() {
        api('/api/queue', {
            method: 'POST',
            body: {
                ids: this.ids, index: this.index, mode: this.mode,
                shuffle: this.shuffle, enabled: this.enabled, origin: this.origin,
            },
        }).catch(() => { /* 存不上不阻塞播放，下次变化会重试 */ });
    }

    /* ---------- 查询 ---------- */

    get size() { return this.ids.length; }
    // 成员判定只看 ids —— items 只是元数据缓存，清空队列后必须立刻失效，
    // 否则「清空→重开」会以为视频还在队列里，什么都不重建
    has(id) { return this.ids.includes(Number(id)); }
    get(id) { return this.items.get(Number(id)) || null; }
    current() { return this.items.get(this.ids[this.index]) || null; }

    setIndexTo(id) {
        const i = this.ids.indexOf(Number(id));
        if (i < 0 || i === this.index) return;
        this.index = i;
        this._changed();
    }

    /* ---------- 生成 ---------- */

    /** 用一份目录列表（自然序）重建队列，并从 startId 开始。 */
    setFromFolder(list, startId, origin) {
        this.items = new Map(list.map(m => [Number(m.id), m]));
        this.ids = list.map(m => Number(m.id));
        this.origin = origin || '';
        this.enabled = true;
        let i = this.ids.indexOf(Number(startId));
        if (i < 0) i = 0;
        this.index = i;
        this._playOrder = null;
        this._changed();
    }

    /**
     * 确保 item 在队列里：在 → 只把索引移过去；不在 → 按它所在目录的
     * 自然序重建队列（「下一集」的核心）。返回是否发生了重建。
     */
    async ensureFor(item) {
        if (!item) return false;
        const id = Number(item.id);
        if (this.has(id)) { this.setIndexTo(id); return false; }
        if (!this.enabled) return false;
        const list = await this._fetchFolder(item.source_id, item.folder || '');
        if (!list.length) return false;
        this.setFromFolder(list, id, item.folder || '');
        return true;
    }

    async _fetchFolder(sourceId, folder) {
        const out = [];
        for (let page = 0; page < MAX_PAGES; page++) {
            const p = new URLSearchParams({
                sources: String(sourceId), kinds: 'video', folder,
                order: 'natural', limit: String(PAGE), offset: String(out.length),
            });
            let d;
            try {
                d = await api('/api/media?' + p.toString());
            } catch {
                break;
            }
            const media = d.media || [];
            out.push(...media);
            if (!media.length || out.length >= (d.total || 0)) break;
        }
        return out;
    }

    /* ---------- 播放顺序 ---------- */

    _order() {
        if (!this.shuffle) return this.ids;
        if (!this._playOrder || this._playOrder.length !== this.ids.length) this._reshuffle();
        return this._playOrder;
    }

    _reshuffle() {
        // 当前项置顶，其余洗牌 —— 随机不打断正在播放的这一集
        const cur = this.ids[this.index];
        const rest = this.ids.filter(id => id !== cur);
        for (let i = rest.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        this._playOrder = (cur != null && cur !== undefined) ? [cur, ...rest] : rest;
    }

    /** 下一个（考虑随机与循环）。没有可播的返回 null。 */
    next() {
        if (!this.ids.length) return null;
        if (this.mode === 'one') return this.ids[this.index] ?? null;
        const order = this._order();
        const pos = order.indexOf(this.ids[this.index]);
        if (pos === -1) return order[0] ?? null;
        if (pos + 1 < order.length) return order[pos + 1];
        return this.mode === 'all' ? (order[0] ?? null) : null;
    }

    /** 上一个（考虑随机与循环）。没有可播的返回 null。 */
    prev() {
        if (!this.ids.length) return null;
        if (this.mode === 'one') return this.ids[this.index] ?? null;
        const order = this._order();
        const pos = order.indexOf(this.ids[this.index]);
        if (pos === -1) return order[0] ?? null;
        if (pos - 1 >= 0) return order[pos - 1];
        return this.mode === 'all' ? (order[order.length - 1] ?? null) : null;
    }

    /* ---------- 编辑 ---------- */

    /** 拖拽排序：把 from 位置的项移到 to。当前播放项不因拖拽而改变。 */
    move(from, to) {
        if (from === to || from < 0 || to < 0
            || from >= this.ids.length || to >= this.ids.length) return;
        const curId = this.ids[this.index];
        const [id] = this.ids.splice(from, 1);
        this.ids.splice(to, 0, id);
        this.index = this.ids.indexOf(curId);
        this._playOrder = null;
        this._changed();
    }

    remove(id) {
        const i = this.ids.indexOf(Number(id));
        if (i < 0) return;
        this.ids.splice(i, 1);
        this.items.delete(Number(id));
        if (i < this.index) this.index -= 1;
        else if (i === this.index) this.index = Math.min(this.index, this.ids.length - 1);
        this._playOrder = null;
        this._changed();
    }

    /** 清空并关闭自动生成 —— 否则下次切换视频又会按目录建回来。 */
    clear() {
        this.ids = [];
        this.index = -1;
        this.origin = '';
        this.enabled = false;
        this.items.clear();
        this._playOrder = null;
        this._changed();
    }

    setEnabled(on) {
        this.enabled = !!on;
        this._changed();
    }

    setMode(m) {
        if (!MODES.includes(m) || m === this.mode) return;
        this.mode = m;
        this._changed();
    }

    /** 循环三态轮换：off → all → one → off。返回新模式。 */
    cycleMode() {
        const i = MODES.indexOf(this.mode);
        this.setMode(MODES[(i + 1) % MODES.length]);
        return this.mode;
    }

    toggleShuffle() {
        this.shuffle = !this.shuffle;
        this._playOrder = null;
        this._changed();
        return this.shuffle;
    }
}
