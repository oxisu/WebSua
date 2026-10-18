/**
 * 竖屏视频流（刷视频模式）。
 *
 * 关键设计：
 *  1. 滚动吸附 —— scroll-snap 让每条正好占满一屏，滚动手感接近原生短视频
 *  2. 窗口化 —— 只给当前条目创建播放器，上下各预载一条，其余只放占位
 *  3. IntersectionObserver 判定「当前条目」，比监听 scroll 更准更省
 *  4. 预取 —— 接近底部时自动加载下一批，避免滚到空白
 *  5. 坏条目自动跳过 —— 播放器 onError 时连跳，防止卡死在一条打不开的视频上
 *  6. 播放队列 —— 翻页/连播沿「下一集」的目录自然序走（见 queue.js），
 *     随机流只负责发现，队列负责连续
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
        this.queue = opts.queue || null;      // 播放队列（「下一集」），可为空
        this.items = [];
        this.currentIndex = 0;
        this.offset = 0;
        this.total = 0;
        this.loading = false;
        this.exhausted = false;
        this.filter = { sources: [], kinds: ['video'], order: 'random', folder: '' };
        this.slides = new Map();   // mediaId -> {node, player}
        this.observer = null;
        this._syncTimer = null;    // 队列重建防抖
        this._queueNav = false;    // 队列导航中：暂停 _syncQueue，避免竞争
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

        // 可视区尺寸变化（旋屏 / 侧栏折叠）时重新摆放导航按钮
        this._onResize = () => this._positionNav();
        window.addEventListener('resize', this._onResize);

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
        this._positionNav();
    }

    setFilter(filter) {
        // 不带 folder 的筛选（切来源 / 重新随机等）一律清掉目录限定 ——
        // 否则沿队列切过目录后，旧 folder 会一直粘在筛选条件上
        this.filter = { ...this.filter, ...filter, folder: filter.folder || '' };
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
        if (f.folder) p.set('folder', f.folder);
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
        // 队列跟随：正在播的这条就是「下一集」的锚点
        this._syncQueue(entry);
        // 提前取下一批
        if (index >= this.items.length - PRELOAD_RADIUS - 2) this.loadMore();
    }

    /**
     * 把当前播放项同步进队列。
     *
     *  - 已在队列里 → 立即把队列索引移过来（面板高亮不延迟）；
     *  - 不在 → 防抖 350ms 后按它所在目录重建队列。防抖是必须的：
     *    随机流里连续滑过几个不同目录的视频时，只有最后停留的那个
     *    才值得生成队列，否则每滑一条就打一次目录接口。
     */
    _syncQueue(item) {
        if (!this.queue || !item || this._queueNav) return;
        if (this.queue.has(item.id)) { this.queue.setIndexTo(item.id); return; }
        clearTimeout(this._syncTimer);
        this._syncTimer = setTimeout(() => {
            if (this._queueNav) return;
            this.queue.ensureFor(item)
                .then(() => { if (this.onQueueChange) this.onQueueChange(); })
                .catch(() => {});
        }, 350);
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
            subtitle: item.subtitle || undefined,
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
    /**
     * 上一条 / 下一条。
     *
     * 队列优先：连播、上下键、导航按钮都沿「下一集」顺序走；
     * 队列播到头（循环关）才回落到视频流自身的顺序。
     */
    go(delta, { smooth = true } = {}) {
        if (this.queue?.enabled && this.queue.size && Math.abs(delta) === 1) {
            const id = delta > 0 ? this.queue.next() : this.queue.prev();
            if (id != null) { this.jumpToQueue(id, { smooth }); return; }
        }
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
        this._positionNav();
    }

    /**
     * 把上一条/下一条导航按钮摆在**可视区**垂直中点。
     *
     * 按钮是 .feed（可滚动容器）的绝对定位子元素，会随内容一起滚走 ——
     * 直接 top:50% 在滚动后永远点不到。用 transform 抵消滚动量，
     * 视觉位置 = 内容顶部 - scrollTop + (scrollTop + 半屏高 - 半键高) = 半屏高 - 半键高。
     */
    _positionNav() {
        if (!this.prevBtn || !this.nextBtn) return;
        const y = this.root.scrollTop + this.root.clientHeight / 2 - 20;
        const t = `translateY(${y}px)`;
        this.prevBtn.style.transform = t;
        this.nextBtn.style.transform = t;
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
            this._positionNav();
            // 到底部时预取
            if (this.root.scrollHeight - this.root.scrollTop - this.root.clientHeight < h * 2) {
                this.loadMore();
            }
        });
    }

    /**
     * 跳到指定媒体（从队列或媒体库点进来时用）。
     *
     * 语义是「进入这条视频的连播上下文」：视频流切成它所在目录的自然序列表，
     * 随机序里定位是不可复现的（SQLite RANDOM() 每次结果不同），目录序才确定。
     * 唯一例外：整个视频流已经就是这个目录的自然序、且目标就在里面 ——
     * 沿队列连播时的常态，直接滚过去即可，不必为切一集重建整个列表。
     */
    async jumpTo(mediaId, opts = {}) {
        const smooth = opts.smooth !== false;
        // 元数据：队列缓存 → 当前列表 → 接口
        let meta = this.queue?.get(mediaId)
            || this.items.find(m => m.id === mediaId) || null;
        if (!meta) {
            try {
                const d = await api(`/api/media/${mediaId}`);
                meta = { folder: d.folder, source_id: d.source_id };
            } catch { /* 拿不到就退回旧行为 */ }
        }
        if (meta && meta.folder != null && meta.source_id != null) {
            const inList = this.items.some(m => m.id === mediaId);
            const sameFolder = this.items.length > 0 && this.filter.order === 'natural'
                && (this.filter.folder || '') === (meta.folder || '')
                && this.items.every(m => m.folder === meta.folder
                    && m.source_id === meta.source_id);
            if (inList && sameFolder) {
                const node = this.slides.get(mediaId)?.node;
                if (node) node.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
                this._syncQueue(this.items[this.items.findIndex(m => m.id === mediaId)]);
                return true;
            }
            return this._loadFolderAndActivate(meta.source_id, meta.folder, mediaId, smooth);
        }
        // 元数据也拿不到 —— 清掉筛选重取一次（旧行为，兜底）
        const origSources = this.filter.sources;
        const data = await api('/api/media?' + this._query({ limit: '200', offset: '0' }));
        this.filter.sources = origSources;
        this.items = data.media || [];
        this.slides.clear();
        this.observer.disconnect();
        this.root.innerHTML = '';
        this.root.append(this.prevBtn, this.nextBtn);
        this._appendSlides();
        const idx = this.items.findIndex(m => m.id === mediaId);
        if (idx === -1) { showToast('未找到该文件', 'err'); return false; }
        const node = this.slides.get(mediaId)?.node;
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
        this._syncQueue(this.items[idx]);
        return true;
    }

    /**
     * 沿队列跳转：目标就是当前项时原地重播（单集循环用），
     * 否则切到它所在目录的自然序列表再定位。
     */
    async jumpToQueue(id, opts = {}) {
        if (!this.queue?.has(id)) return this.jumpTo(id, opts);
        const cur = this.items[this.currentIndex];
        if (cur && cur.id === id) {
            const slide = this.slides.get(id);
            if (slide?.player) {
                slide.player.currentTime = 0;
                slide.player.resume();
                return true;
            }
        }
        return this.jumpTo(id, opts);
    }

    /** 把视频流切成「某来源某目录」的自然序列表，并激活其中的 mediaId。 */
    async _loadFolderAndActivate(sourceId, folder, mediaId, smooth = true) {
        this._queueNav = true;
        try {
            // folder 必须一起进筛选条件：少了它，「这个目录的自然序」会变成
            // 「整个源的自然序」，连播直接乱套
            this.filter = {
                ...this.filter, sources: [sourceId], kinds: ['video'],
                folder: folder || '', order: 'natural',
            };
            await this.reset();
            // 目录可能跨页：翻页找目标，封顶 20 页
            for (let i = 0;
                 i < 20 && this.items.length
                 && !this.items.some(m => m.id === mediaId) && !this.exhausted;
                 i++) {
                await this.loadMore();
            }
            const idx = this.items.findIndex(m => m.id === mediaId);
            if (idx === -1) {
                showToast('未找到该文件', 'err');
                return false;
            }
            // 距离远时瞬间定位：平滑滚动会触发一连串中间条的激活，
            // 每个都建/销一次播放器，纯属浪费
            const dist = Math.abs(idx - Math.max(0, this.currentIndex));
            this._activate(idx);
            const node = this.slides.get(mediaId)?.node;
            if (node) {
                node.scrollIntoView({
                    behavior: smooth && dist <= 2 ? 'smooth' : 'auto', block: 'start',
                });
            }
            return true;
        } finally {
            this._queueNav = false;
            // reset/翻页过程中的 _activate 可能动过队列索引，导航结束后对齐
            this.queue?.setIndexTo(mediaId);
            if (this.onQueueChange) this.onQueueChange();
        }
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
        this.filter = { ...this.filter, sources: sources || [], order: effOrder, folder: '' };
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
        window.removeEventListener('resize', this._onResize);
        clearTimeout(this._syncTimer);
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
