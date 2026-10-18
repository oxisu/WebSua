/**
 * 应用入口：视图路由、侧栏筛选、队列、主题、响应式。
 */

import { $, el, api, initTheme, cycleTheme, showToast, debounce, throttle, formatSize, formatTime } from './utils.js';
import { loadProgress } from './progress.js';
import { VideoFeed } from './feed.js';
import { MediaGrid, toggleFav } from './grid.js';
import { getThumbnail } from './thumbs.js';
import { SourceManager, icon, openModal, switchRow, field } from './sources.js';
import { getSetting, setSetting, allSettings, onSettingsChange } from './settings.js';
import { destroyActivePlayer } from './video-player.js';

const app = {
    view: 'feed',
    sources: [],
    activeSources: new Set(),   // 空集 = 全部
    activeSource: null,         // 当前聚焦的源 id（点击来源时）
    queue: [],
    feed: null,
    grid: null,
    srcMgr: null,
    libMode: 'all',             // 媒体库筛选：all | history | fav
};

/* ============================================================
   启动
   ============================================================ */
async function boot() {
    initTheme();
    buildShell();
    await loadProgress();
    await refreshSources();
    wireGlobalEvents();
    // 恢复上次播放会话（源/顺序/当前进度），失败则从默认视频流开始
    if (!await restoreSession()) {
        switchView('feed');
    }
}

function buildShell() {
    const root = $('#app');

    /* ---- 顶栏 ---- */
    const menuBtn = el('button', {
        class: 'icon-btn', id: 'menuBtn', 'aria-label': '数据源',
        onclick: () => root.classList.toggle('side-open'),
    }, icon('menu'));
    menuBtn.style.display = 'none';
    // 只有手机需要抽屉按钮
    const mq = window.matchMedia('(max-width: 639px)');
    const syncMenu = () => { menuBtn.style.display = mq.matches ? 'grid' : 'none'; };
    mq.addEventListener('change', syncMenu);
    syncMenu();

    const searchInput = el('input', {
        type: 'search', placeholder: '搜索文件名…', 'aria-label': '搜索',
        oninput: debounce(e => {
            const q = e.target.value.trim();
            app.grid?.setFilter({ q });
            if (q && app.view !== 'library') switchView('library');
        }, 350),
    });

    const topbar = el('header', { class: 'topbar' },
        menuBtn,
        el('div', { class: 'brand' },
            el('div', { class: 'brand-mark' }, 'W'),
            el('div', { class: 'brand-text' }, 'WebSua')),
        el('nav', { class: 'nav' },
            navBtn('feed', '视频流', 'play'),
            navBtn('library', '媒体库', 'grid'),
            navBtn('sources', '数据源', 'server')),
        el('div', { class: 'topbar-spacer' }),
        el('div', { class: 'search' }, icon('search', 15), searchInput),
        el('button', {
            class: 'icon-btn theme-btn', 'aria-label': '切换主题',
            title: '主题：跟随系统 / 亮 / 暗',
            onclick: () => {
                const m = cycleTheme();
                showToast(m === 'auto' ? '主题：跟随系统' : m === 'light' ? '主题：亮色' : '主题：暗色');
            },
        },
            icon('auto', 18, 'icon-auto'),
            icon('sun', 18, 'icon-sun'),
            icon('moon', 18, 'icon-moon')),
        el('button', {
            class: 'icon-btn', 'aria-label': '设置', title: '设置',
            onclick: () => openSettings(),
        }, icon('settings', 18)),
        el('button', {
            class: 'icon-btn', 'aria-label': '刷新', title: '刷新',
            onclick: () => refreshAll(),
        }, icon('refresh')));

    /* ---- 侧栏 ---- */
    const sideList = el('div', { class: 'source-list', id: 'sideList' });
    const sidebar = el('aside', { class: 'sidebar' },
        el('div', { class: 'side-head' },
            el('span', { class: 'side-title' }, '文件源'),
            el('button', {
                class: 'icon-btn', style: { width: '28px', height: '28px' },
                'aria-label': '添加数据源',
                onclick: () => app.srcMgr?.openEditor(null),
            }, icon('plus', 16))),
        sideList,
        el('div', { class: 'side-foot' },
            el('button', {
                class: 'btn btn-ghost btn-sm',
                style: { width: '100%', justifyContent: 'center' },
                onclick: () => app.srcMgr?.scanAll(),
            }, el('span', {}, '全部扫描'), icon('refresh', 14))));

    /* ---- 内容 ---- */
    const feedView = el('section', { class: 'view', id: 'view-feed' });
    const libraryView = el('section', { class: 'view', id: 'view-library' });
    const sourcesView = el('section', { class: 'view sources-view', id: 'view-sources' });

    // 媒体库顶部筛选栏：全部 / 历史 / 收藏
    const libFilter = el('div', { class: 'lib-filter' },
        libChip('all', '全部', 'grid'),
        libChip('history', '历史', 'log'),
        libChip('fav', '收藏', 'star'));
    libraryView.append(libFilter);

    const content = el('main', { class: 'content' }, feedView, libraryView, sourcesView);

    /* ---- 队列 ---- */
    const queueList = el('div', { class: 'queue-list', id: 'queueList' });
    // 队列（「接下来」）滚动到底自动加载下一页，与媒体库一致
    queueList.addEventListener('scroll', throttle(() => {
        const { scrollTop, scrollHeight, clientHeight } = queueList;
        if (scrollHeight - scrollTop - clientHeight < clientHeight * 1.2 && app.feed) {
            app.feed.loadMore();   // loadMore 内部会回调 onOpenDetail(=renderQueue)
        }
    }, 200));
    const queueBody = el('div', { class: 'queue-body' }, queueList);
    const queue = el('aside', { class: 'queue' },
        el('div', { class: 'queue-head' },
            el('span', { class: 'side-title' }, '接下来'),
            el('div', { class: 'queue-tools' },
                el('button', {
                    class: 'icon-btn queue-refresh', style: { width: '28px', height: '28px' },
                    'aria-label': '重新随机',
                    title: '重新随机',
                    onclick: () => { app.feed?.reset(); renderQueue(); },
                }, icon('refresh', 14)),
                el('button', {
                    class: 'icon-btn queue-toggle', style: { width: '28px', height: '28px' },
                    'aria-label': '收起队列', title: '收起 / 展开队列',
                    onclick: () => {
                        const collapsed = document.body.classList.toggle('queue-collapsed');
                        document.querySelectorAll('.queue-toggle').forEach(b => {
                            b.setAttribute('aria-label', collapsed ? '展开队列' : '收起队列');
                        });
                    },
                }, icon('chevron', 14)))));
    queue.append(queueBody);

    /* ---- 底部标签栏 ---- */
    const tabbar = el('nav', { class: 'tabbar' },
        tabBtn('feed', '视频流', 'play'),
        tabBtn('library', '媒体库', 'grid'),
        tabBtn('sources', '数据源', 'server'));

    root.innerHTML = '';
    root.append(topbar,
        el('div', { class: 'body' }, sidebar, content, queue),
        tabbar,
        el('div', { class: 'side-mask', onclick: () => root.classList.remove('side-open') }));

    /* ---- 初始化子模块 ---- */
    app.feed = new VideoFeed(feedView, { onOpenDetail: renderQueue });
    app.grid = new MediaGrid(libraryView, {
        onPlay: m => { switchView('feed'); app.feed.jumpTo(m.id); renderQueue(); },
        onJump: m => openImageViewer(m),
    });
    app.srcMgr = new SourceManager(sourcesView, {
        onChanged: () => { refreshSources(); app.grid?.reset(); },
    });
    app.srcMgr.load();
    app.libMode = 'all';
    setLibMode('all');
}

function navBtn(view, label, ico) {
    return el('button', {
        class: 'nav-btn', dataset: { view },
        onclick: () => switchView(view),
    }, label);
}

function libChip(mode, label, ico) {
    return el('button', {
        class: 'lib-chip',
        dataset: { mode },
        onclick: () => setLibMode(mode),
    }, icon(ico, 14), el('span', {}, label));
}

/** 切换媒体库的筛选模式（全部/历史/收藏）。 */
function setLibMode(mode) {
    app.libMode = mode;
    document.querySelectorAll('.lib-chip').forEach(c =>
        c.classList.toggle('active', c.dataset.mode === mode));
    if (app.grid) {
        app.grid.setFilter({
            history: mode === 'history',
            fav: mode === 'fav',
        });
    }
}

function tabBtn(view, label, ico) {
    return el('button', {
        class: 'tab', dataset: { view },
        onclick: () => switchView(view),
    }, icon(ico, 20), el('span', { class: 'tab-label' }, label));
}

/* ============================================================
   视图切换
   ============================================================ */
function switchView(view, opts = {}) {
    app.view = view;
    document.querySelectorAll('.view').forEach(v =>
        v.classList.toggle('active', v.id === `view-${view}`));
    document.querySelectorAll('[data-view]').forEach(b =>
        b.classList.toggle('active', b.dataset.view === view));

    if (view === 'feed') {
        // 进入时如果没内容，加一次（恢复会话流程会 skipAutoLoad 避免竞争）
        if (!app.feed.items.length && !opts.skipAutoLoad) app.feed.setFilter(currentSourceFilter());
        else app.feed.resumeCurrent();
    } else {
        // 离开视频流：暂停并卸载播放器，避免后台继续拉流
        app.feed.pauseAll();
    }

    if (view === 'library' && !app.grid.items.length) {
        app.grid.setFilter(currentSourceFilter());
    }
    if (view === 'sources') app.srcMgr.load();

    location.hash = view === 'feed' ? '' : view;
}

function currentSourceFilter() {
    const sources = app.activeSources.size ? [...app.activeSources] : [];
    return { sources };
}

/* ============================================================
   数据源
   ============================================================ */
async function refreshSources() {
    try {
        const data = await api('/api/sources');
        app.sources = data.sources || [];
        renderSideList();
        const filter = currentSourceFilter();
        // 源列表变化（含停用/删除）后，视频流必须重新加载：
        // 后端查询已过滤停用源，reset 后停用源的内容会从视频流和队列消失。
        // 停用操作只发生在数据源视图，此时视频流必然不在前台（切走时已暂停），
        // reset 不会打断播放。
        if (app.feed && app.feed.items.length) {
            app.feed.setFilter(filter);
        }
    } catch (e) {
        showToast('数据源加载失败：' + e.message, 'err');
    }
}

function renderSideList() {
    const host = $('#sideList');
    if (!host) return;
    host.innerHTML = '';

    host.append(sourceRow({
        id: null, name: '全部来源',
        counts: app.sources.reduce((a, s) => {
            a.all += s.counts?.all || 0;
            a.video = (a.video || 0) + (s.counts?.video || 0);
            return a;
        }, { all: 0, video: 0 }),
        color: 'var(--brand-grad)', enabled: true,
    }, app.activeSources.size === 0));

    if (app.sources.length) {
        host.append(el('div', {
            class: 'side-group-label',
            style: {
                padding: '10px 12px 4px', fontSize: '10.5px',
                color: 'var(--fg-3)', letterSpacing: '.08em',
                textTransform: 'uppercase',
            },
            // 注意：不要写内联 display —— 平板图标条模式要靠 CSS 把它藏起来，
            // 内联 display:block 的优先级会压过断点里的 display:none
        }, '单独筛选'));
    }

    for (const s of app.sources) host.append(sourceRow(s, app.activeSources.has(s.id)));
}

function sourceRow(s, isActive) {
    const scanning = s.scan_running;
    const row = el('button', {
        class: `source-item ${isActive ? 'active' : ''}`,
        title: `${s.name} · ${s.counts?.all || 0} 个文件`,
        onclick: () => {
            if (s.id === null) {
                app.activeSources.clear();
                app.activeSource = null;
            } else {
                if (app.activeSources.has(s.id)) app.activeSources.delete(s.id);
                else app.activeSources.add(s.id);
                app.activeSource = app.activeSources.size === 1 ? s.id : null;
            }
            renderSideList();
            const f = currentSourceFilter();
            app.feed.setFilter({ ...f, kinds: ['video'], order: 'random' });
            if (app.view === 'library') app.grid.setFilter(f);
            else switchView('feed');
            document.getElementById('app').classList.remove('side-open');
        },
    },
        el('span', {
            class: `source-dot ${s.enabled ? '' : 'off'} ${scanning ? 'scanning' : ''}`,
            style: { background: s.id === null ? '' : (s.color || 'var(--brand-1)') },
        }),
        el('span', { class: 'source-info' },
            el('span', { class: 'source-name' }, s.name),
            el('span', { class: 'source-meta' },
                scanning ? '扫描中…'
                    : `${s.counts?.video || 0} 视频 · ${s.counts?.all || 0} 文件`)));

    // 双击 = 只看这个源
    row.addEventListener('dblclick', () => {
        app.activeSources.clear();
        if (s.id !== null) app.activeSources.add(s.id);
        renderSideList();
    });
    return row;
}

/* ============================================================
   队列
   ============================================================ */
function renderQueue() {
    const host = $('#queueList');
    if (!host || !app.feed) return;
    const items = app.feed.items;
    host.innerHTML = '';

    if (!items.length) {
        host.append(el('div', {
            style: { padding: '20px 12px', fontSize: '12px', color: 'var(--fg-3)', textAlign: 'center' },
        }, '播放列表为空'));
        return;
    }

    const start = Math.max(0, app.feed.currentIndex);
    items.forEach((m, i) => {
        const isCur = i === app.feed.currentIndex;
        const thumb = el('div', { class: 'q-thumb' });
        if (m.kind === 'image') {
            thumb.append(el('img', { src: m.stream, loading: 'lazy', alt: '' }));
        } else if (m.poster) {
            thumb.append(el('div', { class: 'thumb-ph' },
                icon('film', 16)));
            const pimg = el('img', { src: m.poster, alt: '' });
            pimg.addEventListener('load', () => { thumb.innerHTML = ''; thumb.append(pimg); });
            pimg.addEventListener('error', () => {
                pimg.remove();
                getThumbnail(m.id, m.stream).then(url => {
                    if (!url || !thumb.isConnected) return;
                    thumb.innerHTML = '';
                    thumb.append(el('img', { src: url, alt: '' }));
                });
            });
            thumb.append(pimg);
        } else {
            thumb.append(el('div', { class: 'thumb-ph' },
                icon(m.kind === 'audio' ? 'music' : 'film', 16)));
            getThumbnail(m.id, m.stream).then(url => {
                if (!url || !thumb.isConnected) return;
                thumb.innerHTML = '';
                thumb.append(el('img', { src: url, alt: '' }));
            });
        }
        if (m.duration) thumb.append(el('span', { class: 'dur' }, formatTime(m.duration)));

        const node = el('div', {
            class: `q-item ${isCur ? 'playing' : ''}`,
            onclick: () => {
                const node2 = app.feed.slides.get(m.id)?.node;
                if (node2) node2.scrollIntoView({ behavior: 'smooth', block: 'start' });
            },
        }, thumb,
            el('div', { class: 'q-info' },
                el('div', { class: 'q-title' }, m.name),
                el('div', { class: 'q-meta' }, `${m.source_name || ''} · ${formatSize(m.size)}`)),
            el('button', {
                class: `card-fav ${m.is_fav ? 'on' : ''}`,
                style: { position: 'static', opacity: m.is_fav ? 1 : 0 },
                'aria-label': '收藏',
                onclick: async e => {
                    e.stopPropagation();
                    await toggleFav(m, e.currentTarget);
                    renderQueue();
                },
            }, heartSvg(m.is_fav)));
        host.append(node);
    });

    // 底部：分页状态（加载更多 / 已加载全部）
    const feed = app.feed;
    if (feed.exhausted) {
        host.append(el('div', { class: 'queue-foot' },
            `已加载全部 ${feed.total} 个文件`));
    } else {
        const btn = el('button', {
            class: 'queue-foot queue-more',
            disabled: feed.loading,
            onclick: async () => {
                await feed.loadMore();   // 完成后回调 renderQueue
            },
        },
            feed.loading ? el('span', { class: 'btn-spinner' }) : icon('chevron', 12),
            feed.loading ? '加载中…' : `加载更多（还有 ${Math.max(0, feed.total - feed.items.length)} 个）`);
        host.append(btn);
    }

    // 当前播放的滚到可见
    const cur = host.querySelector('.q-item.playing');
    cur?.scrollIntoView({ block: 'nearest' });
}

function heartSvg(filled) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '14');
    s.setAttribute('height', '14');
    s.setAttribute('fill', filled ? 'currentColor' : 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z');
    s.append(p);
    return s;
}

/* ============================================================
   设置
   ============================================================ */
function openSettings() {
    const s = allSettings();

    const mkSwitch = (key, title, desc) => switchRow(title, desc, getSetting(key), v => {
        setSetting(key, v);
        applyRuntimeSetting(key, v);
    });

    // 分页大小：下拉选择，改完下次加载生效
    const mkPageSelect = (key, title, desc, options) => {
        const sel = el('select', {
            onchange: e => {
                setSetting(key, parseInt(e.target.value, 10));
                showToast('已保存，下次加载生效', 'ok');
            },
        });
        for (const n of options) {
            const opt = el('option', { value: String(n) }, `${n} 条/页`);
            if (n === getSetting(key)) opt.selected = true;
            sel.append(opt);
        }
        return field(title, sel, desc);
    };

    const body = el('div', {},
        mkSwitch('autoNext', '自动连播', '播放完或出错时自动跳到下一个视频（刷视频模式）'),
        mkSwitch('resumeLast', '恢复上次播放', '打开应用时恢复上次的播放源、顺序与当前进度'),
        mkSwitch('autoPlay', '自动播放', '滚动到某个视频时自动开始播放'),
        mkSwitch('debugLog', '播放器调试日志', '在播放器「更多」菜单里提供调试日志开关'),
        el('div', { class: 'settings-sep' }),
        mkPageSelect('pageFeed', '视频流每页条数', '同时决定右侧「接下来」队列的每页条数', [12, 24, 48, 96]),
        mkPageSelect('pageLibrary', '媒体库每页条数', '媒体库网格滚动到底每次加载的条数', [24, 48, 96, 192]));

    openModal({
        title: '设置',
        body,
        actions: [
            {
                label: '恢复默认',
                onClick: async (_btn, close) => {
                    const { resetSettings } = await import('./settings.js');
                    resetSettings();
                    close();
                    openSettings();
                    return false;
                },
            },
            { label: '完成', primary: true },
        ],
    });
}

/** 运行时立即应用某设置（无需刷新）。 */
function applyRuntimeSetting(key, value) {
    if (key === 'debugLog') {
        showToast(value ? '调试日志已开启（下次打开播放器生效）' : '调试日志已关闭', 'ok');
    } else if (key === 'resumeLast') {
        showToast(value ? '将在下次打开时恢复上次播放' : '已关闭会话恢复', 'ok');
    }
}

/* ============================================================
   图片查看器（图片源也能看）
   ============================================================ */
function openImageViewer(m) {
    const body = el('div', { style: { display: 'grid', placeItems: 'center', gap: '12px' } },
        el('img', {
            src: m.stream, alt: m.name,
            style: { maxWidth: '100%', maxHeight: '62vh', borderRadius: 'var(--r-md)' },
        }),
        el('div', { style: { fontSize: '12.5px', color: 'var(--fg-2)', textAlign: 'center' } },
            el('div', {}, m.name),
            el('div', { style: { color: 'var(--fg-3)' } },
                `${m.source_name} · ${formatSize(m.size)}${m.width ? ` · ${m.width}×${m.height}` : ''}`)),
        el('a', { class: 'btn btn-ghost btn-sm', href: `${m.stream}?dl=1`, download: m.name },
            icon('download', 14), '下载原图'));
    openModal({ title: '图片预览', body, actions: [{ label: '关闭', primary: true }] });
}

/* ============================================================
   全局事件
   ============================================================ */
function wireGlobalEvents() {
    window.addEventListener('hashchange', () => {
        const v = location.hash.slice(1);
        if (v && v !== app.view && ['feed', 'library', 'sources'].includes(v)) switchView(v);
    });

    document.addEventListener('keydown', e => {
        // 数字键快速切换视图
        if (e.target.matches('input, textarea')) return;
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        if (document.querySelector('.modal-mask')) return;
        if (e.key === '1') switchView('feed');
        else if (e.key === '2') switchView('library');
        else if (e.key === '3') switchView('sources');
    });

    // 队列随播放进度更新；同时保存会话（源/顺序/当前条）
    setInterval(() => {
        if (app.view === 'feed' && app.feed?.currentIndex !== app._lastIdx) {
            app._lastIdx = app.feed.currentIndex;
            renderQueue();
            saveSession();
        }
    }, 800);

    window.addEventListener('beforeunload', () => {
        saveSession();
        destroyActivePlayer();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) saveSession();
    });
}

/* ============================================================
   会话保存 / 恢复
   ============================================================ */
function saveSession() {
    if (!app.feed || !app.feed.items.length) return;
    const state = {
        sources: [...app.activeSources],
        order: app.feed.filter.order || 'random',
        mediaId: app.feed.items[app.feed.currentIndex]?.id || null,
        savedAt: Date.now(),
    };
    try { localStorage.setItem('websua.session', JSON.stringify(state)); } catch {}
}

async function restoreSession() {
    if (!getSetting('resumeLast')) return false;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('websua.session') || 'null'); } catch {}
    if (!saved || !saved.mediaId) return false;
    // 恢复源筛选
    if (saved.sources?.length) {
        app.activeSources = new Set(saved.sources);
        renderSideList();
    }
    // 先切到视频流让容器可见（跳过自动加载，避免与 restoreSession 的加载竞争）
    switchView('feed', { skipAutoLoad: true });
    const ok = await app.feed.restoreSession(
        saved.mediaId,
        [...app.activeSources],
        saved.order || 'random');
    if (ok) showToast('已恢复上次播放', 'ok');
    return true;
}

async function refreshAll() {
    showToast('正在刷新…');
    await refreshSources();
    await app.srcMgr.load();
    if (app.view === 'library') app.grid.reset();
    else app.feed.reset();
    showToast('已刷新', 'ok');
}

/* ============================================================
   启动
   ============================================================ */
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
