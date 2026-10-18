/**
 * 竖屏视频流（刷视频模式）。
 *
 * 关键设计：
 *  1. 滚动吸附 —— scroll-snap 让每条正好占满一屏，滚动手感接近原生短视频
 *  2. 窗口化 —— 只给当前条目创建播放器，上下各预载一条，其余只放占位
 *  3. IntersectionObserver 判定「当前条目」，比监听 scroll 更准更省
 *  4. 预取 —— 接近底部时自动加载下一批，避免滚到空白
 *  5. 坏条目自动跳过 —— 播放器 onError 时连跳，防止卡死在一条打不开的视频上
 */

import { createVideoPlayer, destroyActivePlayer } from './video-player.js';
import { api, el, formatSize, showToast } from './utils.js';
import { getSetting } from './settings.js';

const PRELOAD_RADIUS = 1;   // 上下各预载几条
const PAGE_DEFAULT = 24;    // 兜底，实际读设置 pageFeed

export class VideoFeed {
    constructor(root, opts = {}) {
        this.root = root;
        this.onOpenDetail = opts.onOpenDetail || (() => {});
        this.items = [];
        this.currentIndex = 0;
        this.offset = 0;
        this.total = 0;
        this.loading = false;
        this.exhausted = false;
        this.filter = { sources: [], kinds: ['video'], order: 'random' };
        this.slides = new Map();   // mediaId -> {node, player}
        this.observer = null;
        this._build();
    }

    _build() {
        // 注意：不能写 this.root.className = 'feed' —— 那会抹掉外层
        // section 的 "view active" 类，导致切换视图时它仍然占位显示。
        this.root.classList.add('feed');
        this.root.innerHTML = '';

        this.prevBtn = el('button', {
            class: 'feed-nav feed-prev', 'aria-label': '上一条',
            onclick: () => this.go(-1),
        }, svg('M15 18l-6-6 6-6'));
        this.nextBtn = el('button', {
            class: 'feed-nav feed-next', 'aria-label': '下一条',
            onclick: () => this.go(1),
        }, svg('M9 18l6-6-6-6'));
        this.root.append(this.prevBtn, this.nextBtn);

        this.observer = new IntersectionObserver(entries => {
            for (const e of entries) {
                if (!e.isIntersecting) continue;
                const idx = Number(e.target.dataset.index);
                if (!Number.isNaN(idx)) this._activate(idx);
            }
        }, { root: this.root, threshold: 0.6 });

        this.root.addEventListener('scroll', this._onScroll.bind(this), { passive: true });

        // 键盘上下键翻页（播放器自己管的是空格/左右）
        this._onKey = e => {
            if (!this.isActive) return;
            const t = e.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
            if (e.key === 'ArrowDown' || e.key === 'k') { e.preventDefault(); this.go(1); }
            else if (e.key === 'ArrowUp' || e.key === 'p') { e.preventDefault(); this.go(-1); }
        };
        document.addEventListener('keydown', this._onKey);
    }

    get isActive() {
        return this.root.offsetParent !== null && this.root.clientHeight > 0;
    }

    /** 离开视频流视图时调用：暂停并卸载播放器，释放远端连接。 */
    pauseAll() {
        for (const s of this.slides.values()) this._unmountPlayer(s);
    }

    /** 回到视频流视图时调用：重新挂载当前条目的播放器。 */
    resumeCurrent() {
        const entry = this.items[this.currentIndex];
        if (!entry) return;
        const slide = this.slides.get(entry.id);
        if (slide && !slide.player) this._mountPlayer(slide);
    }

    setFilter(filter) {
        this.filter = { ...this.filter, ...filter };
        this.reset();
    }

    async reset() {
        destroyActivePlayer();
        this.observer?.disconnect();
        this.slides.clear();
        this.items = [];
        this.offset = 0;
        this.exhausted = false;
        this.currentIndex = -1;
        this.root.innerHTML = '';
        this.root.append(this.prevBtn, this.nextBtn);
        await this.loadMore();
    }

    _query(extra = {}) {
        const f = this.filter;
        const page = Math.max(6, Math.min(200, getSetting('pageFeed') || PAGE_DEFAULT));
        const p = new URLSearchParams({
            limit: String(page),
            offset: String(this.offset),
            order: f.order || 'random',
            ...extra,
        });
        if (f.sources?.length) p.set('sources', f.sources.join(','));
        if (f.kinds?.length) p.set('kinds', f.kinds.join(','));
        return p.toString();
    }

    async loadMore() {
        if (this.loading || this.exhausted) return;
        this.loading = true;
        let appended = false;
        try {
            const data = await api('/api/media?' + this._query());
            const list = data.media || [];
            if (this.items.length === 0 && list.length === 0) {
                this._renderEmpty();
                return;
            }
            for (const m of list) this.items.push(m);
            this.offset += list.length;
            this.total = data.total || 0;
            if (this.offset >= this.total) this.exhausted = true;
            this._appendSlides();
            if (this.currentIndex === -1 && this.items.length) {
                // 注意：不要在这里预设 currentIndex，否则 _activate 的
                // 「index === currentIndex 就返回」守卫会直接短路，播放器永远不挂载。
                this._activate(0);
            }
            appended = true;
        } catch (e) {
            showToast('加载失败：' + e.message, 'err');
        } finally {
            this.loading = false;
        }
        // 队列（「接下来」）与 feed 共享数据源，loading 复位后再通知，
        // 否则 renderQueue 读到 loading=true 会把「加载中」状态卡住
        if (appended) this.onOpenDetail();
    }

    _appendSlides() {
        for (const item of this.items) {
            if (this.slides.has(item.id)) continue;
            const node = this._makeSlide(item, this.slides.size);
            this.slides.set(item.id, { node, player: null, item });
            this.observer.observe(node);
            this.root.append(node);
        }
        this._updateNav();
    }

    _makeSlide(item, index) {
        const stage = el('div', { class: 'feed-stage' });

        const favBtn = el('button', {
            class: `fav-btn ${item.is_fav ? 'on' : ''}`,
            'aria-label': '收藏',
            onclick: async e => {
                e.stopPropagation();
                await this._toggleFav(item, favBtn);
            },
        }, heartIcon(item.is_fav));

        // 信息条与收藏键同属一个 overlay：收藏永远贴 overlay 右缘内侧，
        // 不再做任何与画面帧宽相关的数学定位
        const overlay = el('div', { class: 'feed-overlay' },
            favBtn,
            el('div', { class: 'feed-overlay-main' },
                el('div', { class: 'feed-title', title: item.name }, item.name),
                el('div', { class: 'feed-sub' },
                    el('span', { class: 'feed-badge' },
                        el('i', {
                            style: {
                                width: '6px', height: '6px', borderRadius: '50%',
                                background: item.source_color || 'var(--brand-1)',
                            },
                        }),
                        item.source_name || '未知来源'),
                    el('span', {}, formatSize(item.size)),
                    item.folder && item.folder !== '/' ? el('span', { class: 'feed-folder' }, item.folder) : null,
                )));

        const node = el('div', {
            class: 'feed-item', dataset: { index: String(index), id: String(item.id) },
        }, stage, overlay);
        return node;
    }

    _renderEmpty() {
        destroyActivePlayer();
        this.root.innerHTML = '';
        this.root.append(this.prevBtn, this.nextBtn);
        this.root.append(el('div', { class: 'feed-skeleton' },
            el('div', { class: 'empty' },
                el('div', { class: 'empty-icon' }, svg('M4 5h16v14H4zM10 9l5 3-5 3V9z', 28)),
                el('h3', {}, '这里还没有视频'),
                el('p', {}, '先到「数据源」添加一个 WebDAV 并扫描，然后回到这里开始刷。'),
                el('button', {
                    class: 'btn btn-primary', style: { marginTop: '8px' },
                    onclick: () => document.querySelector('[data-view="sources"]')?.click(),
                }, '去添加数据源'))));
        this._updateNav();
    }

    /** 激活某一条：只给它建播放器，销毁其他。 */
    _activate(index) {
        if (index === this.currentIndex) return;
        this.currentIndex = index;
        const entry = this.items[index];
        if (!entry) return;

        for (const [id, s] of this.slides) {
            const shouldPlay = id === entry.id;
            if (shouldPlay && !s.player) this._mountPlayer(s);
            else if (!shouldPlay && s.player) this._unmountPlayer(s);
        }
        this._updateNav();
        // 提前取下一批
        if (index >= this.items.length - PRELOAD_RADIUS - 2) this.loadMore();
    }

    _mountPlayer(slide) {
        const { node, item } = slide;
        const stage = node.querySelector('.feed-stage');
        stage.innerHTML = '';
        const holder = el('div', { style: { position: 'absolute', inset: '0' } });
        stage.append(holder);

        slide.player = createVideoPlayer(holder, item.stream, {
            mediaId: item.id,
            title: item.name,
            sourceName: item.source_name,
            fallbackUrl: item.fallback,
            poster: item.poster || undefined,
            autoplay: getSetting('autoPlay'),
            debug: getSetting('debugLog'),
            keyEnabled: true,
            // 播放结束：默认停在结尾（显示重播键），开启「自动连播」才跳下一条
            onEnded: () => {
                if (getSetting('autoNext')) this.go(1);
            },
            // 出错：默认停住展示错误，不自动跳过（避免一连串坏文件时疯狂跳）
            onError: reason => {
                if (getSetting('autoNext')) this._skipBroken(reason);
            },
            onReadyChange: ready => {
                node.classList.toggle('is-ready', ready);
            },
        });
    }

    _unmountPlayer(slide) {
        if (!slide.player) return;
        try { slide.player.destroy(); } catch {}
        slide.player = null;
        const stage = slide.node.querySelector('.feed-stage');
        if (stage) stage.innerHTML = '';
    }

    _skipBrokenCount = 0;

    _skipBroken(reason) {
        if (this._skipBrokenCount > 5) {
            this._skipBrokenCount = 0;
            showToast('连续多个文件无法播放，已暂停', 'err');
            return;
        }
        this._skipBrokenCount++;
        log(`跳过无法播放的条目：${reason}`);
        setTimeout(() => this.go(1, { smooth: false }), 600);
    }
    go(delta, { smooth = true } = {}) {
        const next = Math.max(0, Math.min(this.items.length - 1, this.currentIndex + delta));
        if (next === this.currentIndex) return;
        const node = this.slides.get(this.items[next]?.id)?.node;
        if (!node) return;
        node.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
        this.currentIndex = next;
        this._updateNav();
    }

    _updateNav() {
        if (!this.prevBtn || !this.nextBtn) return;
        this.prevBtn.disabled = this.currentIndex <= 0;
        this.nextBtn.disabled = this.currentIndex >= this.items.length - 1 && this.exhausted;
    }

    _onScroll() {
        if (this._scrollRaf) return;
        this._scrollRaf = requestAnimationFrame(() => {
            this._scrollRaf = null;
            // 用滚动偏移直接算索引：比 elementFromPoint 稳，也不受遮罩层影响
            const h = this.root.clientHeight || 1;
            const idx = Math.round(this.root.scrollTop / h);
            if (idx >= 0 && idx < this.items.length && idx !== this.currentIndex) {
                this._activate(idx);
            }
            // 到底部时预取
            if (this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight < h * 2) {
                this.loadMore();
            }
        });
    }

    /** 跳到指定媒体（从队列点进来时用）。 */
    async jumpTo(mediaId) {
        let idx = this.items.findIndex(m => m.id === mediaId);
        if (idx === -1) {
            // 不在当前列表里 —— 清掉筛选重取一次
            const origSources = this.filter.sources;
            const data = await api('/api/media?' + this._query({ limit: '200', offset: '0' }));
            this.filter.sources = origSources;
            this.items = data.media || [];
            this.slides.clear();
            this.observer.disconnect();
            this.root.innerHTML = '';
            this.root.append(this.prevBtn, this.nextBtn);
            this._appendSlides();
            idx = this.items.findIndex(m => m.id === mediaId);
        }
        if (idx === -1) { showToast('未找到该文件', 'err'); return; }
        const node = this.slides.get(this.items[idx].id)?.node;
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    /**
     * 恢复上次播放会话：恢复源/顺序，并尽量跳到上次的 mediaId。
     *
     * 注意：random 顺序每次重新洗牌（SQLite RANDOM()），mediaId 位置不可复现，
     * 恢复时强制转成「最近」（new）确定性排序，才能精确定位到上次看的视频。
     * 「恢复会话」的语义是继续上次播放，而非复现当时的随机顺序。
     */
    async restoreSession(mediaId, sources, order) {
        const effOrder = (order && order !== 'random') ? order : 'new';
        this.filter = { ...this.filter, sources: sources || [], order: effOrder };
        await this.reset();
        // 翻页找 mediaId，最多 8 页
        for (let i = 0; i < 8 && !this.items.some(m => m.id === mediaId) && !this.exhausted; i++) {
            await this.loadMore();
        }
        const idx = this.items.findIndex(m => m.id === mediaId);
        if (idx >= 0) {
            this._activate(idx);
            const node = this.slides.get(mediaId)?.node;
            if (node) node.scrollIntoView({ behavior: 'auto', block: 'start' });
        }
        return idx >= 0;
    }

    async _toggleFav(item, btn) {
        try {
            const res = await api(`/api/media/${item.id}/fav`, { method: 'POST' });
            item.is_fav = res.favorite;
            btn.classList.toggle('on', res.favorite);
            btn.innerHTML = '';
            btn.append(heartIcon(res.favorite));
            showToast(res.favorite ? '已收藏' : '已取消收藏', 'ok');
            this.onOpenDetail();
        } catch (e) {
            showToast(e.message, 'err');
        }
    }

    destroy() {
        destroyActivePlayer();
        this.observer?.disconnect();
        document.removeEventListener('keydown', this._onKey);
    }
}

/* ---------- 小工具 ---------- */
function svg(path, size = 20, extra = {}) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size);
    s.setAttribute('height', size);
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', extra.width || 2);
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', path);
    s.append(p);
    return s;
}

function heartIcon(filled) {
    const d = 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z';
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '21');
    s.setAttribute('height', '21');
    s.setAttribute('fill', filled ? 'currentColor' : 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    s.append(p);
    return s;
}

function log(msg) {
    if (localStorage.getItem('websua.debug') === '1') console.log('[feed]', msg);
}
