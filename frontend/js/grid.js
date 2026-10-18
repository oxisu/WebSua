/**
 * 媒体网格：按来源 / 目录 / 排序浏览所有已索引文件。
 */

import { api, el, formatSize, showToast, throttle } from './utils.js';
import { getThumbnail } from './thumbs.js';
import { getSetting } from './settings.js';

const PAGE_DEFAULT = 48;   // 兜底，实际读设置 pageLibrary

export class MediaGrid {
    constructor(root, { onPlay, onJump } = {}) {
        this.root = root;
        this.onPlay = onPlay || (() => {});
        this.onJump = onJump || (() => {});
        this.items = [];
        this.offset = 0;
        this.total = 0;
        this.loading = false;
        this.exhausted = false;
        this.filter = {
            sources: [], kinds: [], folder: '', order: 'new',
            q: '', fav: false, history: false,
        };
        this._setup();
    }

    _setup() {
        this.scroll = el('div', { class: 'grid-scroll' });
        this.grid = el('div', { class: 'grid' });
        this.moreWrap = el('div', { class: 'load-more' });
        this.scroll.append(this.grid, this.moreWrap);
        this.root.append(this.scroll);

        // 滚到底自动加载下一页
        this.scroll.addEventListener('scroll', throttle(() => {
            const { scrollTop, scrollHeight, clientHeight } = this.scroll;
            if (scrollHeight - scrollTop - clientHeight < clientHeight * 1.5) this.loadMore();
        }, 200));
    }

    setFilter(f) {
        this.filter = { ...this.filter, ...f };
        this.reset();
    }

    async reset() {
        this.items = [];
        this.offset = 0;
        this.exhausted = false;
        this.grid.innerHTML = '';
        this._showSkeleton();
        await this.loadMore();
    }

    _showSkeleton() {
        this.grid.innerHTML = '';
        for (let i = 0; i < 18; i++) {
            this.grid.append(el('div', { class: 'card' },
                el('div', { class: 'card-thumb sk' }),
                el('div', { class: 'card-body' },
                    el('div', { class: 'sk', style: { height: '10px', width: '85%', marginBottom: '6px' } }),
                    el('div', { class: 'sk', style: { height: '8px', width: '50%' } }))));
        }
        this.moreWrap.innerHTML = '';
    }

    _query() {
        const f = this.filter;
        const page = Math.max(6, Math.min(200, getSetting('pageLibrary') || PAGE_DEFAULT));
        if (f.history) {
            // 历史模式：只支持按源筛选 + 分页
            const p = new URLSearchParams({
                limit: String(page), offset: String(this.offset),
            });
            if (f.sources.length) p.set('sources', f.sources.join(','));
            return p.toString();
        }
        const p = new URLSearchParams({
            limit: String(page), offset: String(this.offset), order: f.order || 'new',
        });
        if (f.sources.length) p.set('sources', f.sources.join(','));
        if (f.kinds.length) p.set('kinds', f.kinds.join(','));
        if (f.folder) p.set('folder', f.folder);
        if (f.q) p.set('q', f.q);
        if (f.fav) p.set('fav', '1');
        return p.toString();
    }

    async loadMore() {
        if (this.loading || this.exhausted) return;
        this.loading = true;
        this.moreWrap.innerHTML = '<div class="sk" style="width:120px;height:32px"></div>';
        try {
            const endpoint = this.filter.history ? '/api/history' : '/api/media';
            const data = await api(endpoint + '?' + this._query());
            const list = data.history || data.media || [];
            if (this.items.length === 0) this.grid.innerHTML = '';
            if (!list.length && this.items.length === 0) {
                this._renderEmpty();
                return;
            }
            for (const m of list) {
                this.items.push(m);
                this.grid.append(this._card(m));
            }
            this.offset += list.length;
            this.total = data.total || 0;
            this.exhausted = this.offset >= this.total;
            this.moreWrap.innerHTML = '';
            if (this.exhausted) {
                this.moreWrap.append(el('div', {
                    style: { color: 'var(--fg-3)', fontSize: '12px' },
                }, `已加载全部 ${this.total} 个文件`));
            } else {
                this.moreWrap.append(el('button', {
                    class: 'btn btn-ghost btn-sm',
                    onclick: () => this.loadMore(),
                }, `加载更多（还有 ${Math.max(0, this.total - this.offset)} 个）`));
            }
        } catch (e) {
            showToast('加载失败：' + e.message, 'err');
            this.moreWrap.innerHTML = '';
        } finally {
            this.loading = false;
        }
    }

    _renderEmpty() {
        this.grid.innerHTML = '';
        const emptyTitle = this.filter.history ? '还没有观看历史'
            : this.filter.q ? '没有匹配的文件' : '这里还没有文件';
        const emptyDesc = this.filter.history ? '看过的视频会出现在这里，下次可从这里继续观看。'
            : this.filter.q ? `没有找到包含「${this.filter.q}」的文件`
            : '添加 WebDAV 数据源并扫描后，文件会出现在这里。';
        this.grid.append(el('div', {
            class: 'empty',
            style: { gridColumn: '1/-1', minHeight: '50vh' },
        },
            el('div', { class: 'empty-icon' }, iconOf('grid', 30)),
            el('h3', {}, emptyTitle),
            el('p', {}, emptyDesc),
            this.filter.q && !this.filter.history ? el('button', {
                class: 'btn btn-ghost', onclick: () => this.setFilter({ q: '' }),
            }, '清除搜索') : null));
    }

    _card(m) {
        const resumePct = m.duration && m.position
            ? Math.min(100, (m.position / m.duration) * 100) : 0;

        const thumb = el('div', { class: 'card-thumb' });
        if (m.kind === 'image') {
            // 图片：直接用流地址（浏览器原生支持）；加载失败回退占位图标
            const ph = makeThumbPlaceholder(m);
            thumb.append(ph);
            const img = el('img', { src: m.stream, loading: 'lazy', alt: m.name });
            img.addEventListener('load', () => { ph.remove(); thumb.classList.add('has-img'); });
            img.addEventListener('error', () => img.remove());   // 留占位图标
            thumb.append(img);
        } else {
            // 视频/音频：优先 TG 同名封面，其次异步截帧。
            // poster 由后端按「该源是否开启 tg_mode」决定是否匹配返回
            thumb.append(makeThumbPlaceholder(m));
            if (m.poster) {
                attachPoster(thumb, m.poster);
            } else {
                attachThumbnail(thumb, m);
            }
        }
        thumb.append(el('div', { class: 'card-ext' }, (m.ext || m.kind || '').replace('.', '')));

        const fav = el('button', {
            class: `card-fav ${m.is_fav ? 'on' : ''}`,
            'aria-label': '收藏',
            onclick: async e => {
                e.stopPropagation();
                await toggleFav(m, fav);
            },
        }, heart(m.is_fav));
        thumb.append(fav);

        const card = el('div', {
            class: 'card',
            onclick: () => {
                if (m.kind === 'video') this.onPlay(m);
                else if (m.kind === 'image') this.onJump(m);
                else showToast('暂不支持直接播放该格式', 'warn');
            },
        }, thumb,
            el('div', { class: 'card-body' },
                el('div', { class: 'card-name', title: m.name }, m.name),
                el('div', { class: 'card-meta' },
                    el('span', { class: 'card-src' },
                        el('i', { style: { background: m.source_color || 'var(--brand-1)' } }),
                        m.source_name || '—'),
                    m.finished
                        ? el('span', { class: 'card-watched' }, '✓ 已看完')
                        : (resumePct > 0 && m.duration
                            ? el('span', { class: 'card-watched-part' }, `${Math.round(resumePct)}%`)
                            : el('span', {}, formatSize(m.size))))));

        if (resumePct > 0) {
            thumb.append(el('div', { class: 'card-resume' },
                el('i', { style: { width: resumePct + '%' } })));
        }
        return card;
    }
}

export async function toggleFav(m, btn) {
    try {
        const res = await api(`/api/media/${m.id}/fav`, { method: 'POST' });
        m.is_fav = res.favorite;
        btn.classList.toggle('on', res.favorite);
        btn.innerHTML = '';
        btn.append(heart(res.favorite));
        showToast(res.favorite ? '已收藏' : '已取消收藏', 'ok');
    } catch (e) {
        showToast(e.message, 'err');
    }
}

function heart(filled) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '14');
    s.setAttribute('height', '14');
    s.setAttribute('fill', filled ? 'currentColor' : 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z');
    s.append(p);
    return s;
}

function iconOf(name, size = 20) {
    const paths = {
        grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
        play: 'M5 3l14 9-14 9V3z',
        film: 'M4 3h16a1 1 0 011 1v16a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1zM7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4',
        music: 'M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM21 16a3 3 0 11-6 0 3 3 0 016 0z',
    };
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size);
    s.setAttribute('height', size);
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.6');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    for (const d of (paths[name] || '').split('|')) {
        const p = document.createElementNS(ns, 'path');
        p.setAttribute('d', d);
        s.append(p);
    }
    return s;
}

/* ---------- 缩略图：占位 + 异步截帧 ---------- */

function makeThumbPlaceholder(m) {
    const ico = m.kind === 'audio' ? 'music' : 'film';
    return el('div', { class: 'thumb-ph' }, iconOf(ico, 26));
}

function attachThumbnail(thumb, m) {
    getThumbnail(m.id, m.stream).then(url => {
        if (!url || !thumb.isConnected) return;
        const img = el('img', {
            src: url, alt: m.name, draggable: 'false',
        });
        img.addEventListener('load', () => thumb.classList.add('has-img'));
        thumb.prepend(img);
    });
}

/** 直接用 TG 同名封面图（图片流，浏览器原生解码，无需截帧）。 */
function attachPoster(thumb, posterUrl) {
    const img = el('img', { src: posterUrl, alt: '', loading: 'lazy', draggable: 'false' });
    img.addEventListener('load', () => {
        thumb.querySelector('.thumb-ph')?.remove();
        thumb.classList.add('has-img');
    });
    img.addEventListener('error', () => {
        img.remove();
        // 封面加载失败 → 回退截帧需要 media 对象，这里至少留占位
    });
    thumb.prepend(img);
}
