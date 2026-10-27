/**
 * 应用入口：视图路由、侧栏筛选、队列、主题、响应式。
 */

import { $, el, api, initTheme, cycleTheme, showToast, debounce, formatSize, formatTime } from './utils.js';
import { loadProgress } from './progress.js';
import { VideoFeed } from './feed.js';
import { MediaGrid, toggleFav } from './grid.js';
import { FolderTree } from './folder-tree.js';
import { getThumbnail } from './thumbs.js';
import { SourceManager, icon, openModal, switchRow, field } from './sources.js';
import { getSetting, setSetting, allSettings, onSettingsChange } from './settings.js';
import { destroyActivePlayer } from './video-player.js';
import { PlayQueue } from './queue.js';
import { ensureAuth, initAuthGuard } from './auth.js';

const app = {
    view: 'feed',
    sources: [],
    activeSources: new Set(),   // 空集 = 全部
    activeSource: null,         // 当前聚焦的源 id（点击来源时）
    queue: null,
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
    initAuthGuard();            // 注册 401 钩子：令牌过期随时回到登录界面
    await ensureAuth();         // 开启门禁时先弹密码框，通过后才继续
    buildShell();
    await loadProgress();
    await app.queue.load();     // 恢复持久化的播放队列（失败留空，不阻塞启动）
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

    // 媒体库顶部筛选栏：全部 / 未看 / 有进度 / 已看完 / 历史 / 收藏
    const libFilter = el('div', { class: 'lib-filter' },
        libChip('all', '全部', 'grid'),
        libChip('unwatched', '未看', 'eye'),
        libChip('in_progress', '有进度', 'clock'),
        libChip('finished', '已看完', 'check'),
        libChip('history', '历史', 'log'),
        libChip('fav', '收藏', 'star'),
        libChip('duplicates', '重复', 'copy'));

    // 多选开关
    const multiBtn = el('button', {
        class: 'lib-chip lib-multi-btn',
        id: 'libMultiBtn',
        onclick: () => {
            const on = app.grid.toggleMultiSelect();
            multiBtn.classList.toggle('active', app.grid.multiSelect);
            batchBar.style.display = app.grid.multiSelect ? 'flex' : 'none';
            if (!app.grid.multiSelect) batchBar.classList.remove('has-sel');
        },
    }, icon('check', 14), el('span', {}, '多选'));

    // 批量操作栏（多选时底部浮动）
    const batchCount = el('span', { class: 'batch-count', id: 'batchCount' }, '已选 0 项');
    const batchBar = el('div', {
        class: 'batch-bar', id: 'batchBar', style: { display: 'none' },
    },
        batchCount,
        el('button', {
            class: 'btn btn-sm btn-ghost', onclick: () => app.grid.selectAll(),
        }, '全选'),
        el('button', {
            class: 'btn btn-sm btn-ghost', onclick: () => app.grid.invertSelection(),
        }, '反选'),
        el('button', {
            class: 'btn btn-sm btn-ghost', onclick: () => app.grid.clearSelection(),
        }, '清除'),
        el('button', {
            class: 'btn btn-sm btn-primary', id: 'batchFavBtn',
            onclick: () => batchAction('fav'),
        }, '收藏'),
        el('button', {
            class: 'btn btn-sm btn-ghost', id: 'batchUnfavBtn',
            onclick: () => batchAction('unfav'),
        }, '取消收藏'),
        el('button', {
            class: 'btn btn-sm btn-danger', id: 'batchRemoveBtn',
            onclick: () => batchAction('remove'),
        }, '移除索引'));

    libFilter.append(multiBtn);

    // 文件夹树侧栏（媒体库左侧）
    const folderTreeEl = el('aside', { class: 'lib-folder-tree' });

    // 网格容器（树在左、网格在右）
    const libBody = el('div', { class: 'lib-body' }, folderTreeEl);

    libraryView.append(libFilter, libBody, batchBar);

    const content = el('main', { class: 'content' }, feedView, libraryView, sourcesView);

    /* ---- 队列 ---- */
    const queueList = el('div', { class: 'queue-list', id: 'queueList' });
    const queueBody = el('div', { class: 'queue-body' }, queueList);

    // 工具：随机 / 循环 / 清空 / 重新随机 / 收起
    const shuffleBtn = el('button', {
        class: 'icon-btn queue-tool', id: 'queueShuffle',
        style: { width: '28px', height: '28px' },
        'aria-label': '随机播放', title: '随机播放',
        onclick: () => { app.queue.toggleShuffle(); syncQueueTools(); },
    }, icon('shuffle', 14));
    const modeBtn = el('button', {
        class: 'icon-btn queue-tool', id: 'queueMode',
        style: { width: '28px', height: '28px' },
        'aria-label': '循环模式', title: '循环模式',
        onclick: () => { app.queue.cycleMode(); syncQueueTools(); },
    }, icon('repeat', 14));
    const clearBtn = el('button', {
        class: 'icon-btn queue-tool', id: 'queueClear',
        style: { width: '28px', height: '28px' },
        'aria-label': '清空队列', title: '清空队列',
        onclick: () => {
            app.queue.clear();
            syncQueueTools();
            showToast('已清空播放队列，连播随之关闭', 'ok');
        },
    }, icon('trash', 14));
    const refreshBtn = el('button', {
        class: 'icon-btn queue-tool queue-refresh',
        style: { width: '28px', height: '28px' },
        'aria-label': '重新随机', title: '重新随机（回到随机视频流）',
        onclick: () => {
            // 必须显式把 order 拉回 random：沿队列连播时 filter.order
            // 已被切成 natural，只 reset 的话出来还是目录序
            app.feed?.setFilter({ ...currentSourceFilter(), kinds: ['video'], order: 'random' });
        },
    }, icon('refresh', 14));
    const toggleBtn = el('button', {
        class: 'icon-btn queue-toggle', style: { width: '28px', height: '28px' },
        'aria-label': '收起队列', title: '收起 / 展开队列',
        onclick: () => {
            const collapsed = document.body.classList.toggle('queue-collapsed');
            document.querySelectorAll('.queue-toggle').forEach(b => {
                b.setAttribute('aria-label', collapsed ? '展开队列' : '收起队列');
            });
        },
    }, icon('chevron', 14));

    const queue = el('aside', { class: 'queue' },
        el('div', { class: 'queue-head' },
            el('div', { class: 'queue-title-wrap' },
                el('span', { class: 'side-title' }, '播放队列'),
                el('span', { class: 'queue-count', id: 'queueCount' })),
            el('div', { class: 'queue-tools' },
                shuffleBtn, modeBtn, clearBtn, refreshBtn, toggleBtn)));
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
    app.queue = new PlayQueue();
    app.queue.onChange(() => renderQueue());
    app.feed = new VideoFeed(feedView, { onOpenDetail: renderQueue, queue: app.queue });
    app.grid = new MediaGrid(libBody, {
        onPlay: m => {
            switchView('feed');
            // 队列里有的沿队列跳（切目录自然序），没有的普通跳转并按其目录生成队列
            app.feed.jumpToQueue(m.id);
            renderQueue();
        },
        onJump: m => openImageViewer(m),
        onSelectionChange: (sel) => {
            const n = sel.size;
            if (batchCount) batchCount.textContent = `已选 ${n} 项`;
            if (batchBar) batchBar.classList.toggle('has-sel', n > 0);
        },
    });
    app.folderTree = new FolderTree(folderTreeEl, {
        onSelect: (path) => {
            app.grid.setFilter({ folder_prefix: path, folder: '' });
        },
    });
    app.folderTree.load();
    app.srcMgr = new SourceManager(sourcesView, {
        onChanged: () => {
            refreshSources();
            app.grid?.reset();
            app.folderTree?.load();
        },
    });
    app.srcMgr.load();
    app.libMode = 'all';
    setLibMode('all');

    // 调试 / 自动化测试钩子：只读暴露应用实例，方便在控制台里查状态
    window.__wsua = app;
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

/** 切换媒体库的筛选模式（全部/未看/有进度/已看完/历史/收藏）。 */
function setLibMode(mode) {
    app.libMode = mode;
    document.querySelectorAll('.lib-chip').forEach(c =>
        c.classList.toggle('active', c.dataset.mode === mode));
    if (app.grid) {
        const progressMap = { unwatched: 'unwatched', in_progress: 'in_progress', finished: 'finished' };
        app.grid.setFilter({
            history: mode === 'history',
            fav: mode === 'fav',
            duplicates: mode === 'duplicates',
            progress: progressMap[mode] || '',
        });
    }
}

/** 批量操作：fav / unfav / remove。 */
async function batchAction(action) {
    const sel = app.grid?.selected;
    if (!sel || !sel.size) return;
    const ids = [...sel];
    const labels = { fav: '收藏', unfav: '取消收藏', remove: '移除索引' };
    if (action === 'remove') {
        if (!confirm(`确定移除 ${ids.length} 条索引？\n只删本地索引，不删远端文件。`)) return;
    }
    try {
        if (action === 'fav' || action === 'unfav') {
            const r = await api('/api/media/batch-fav', 'POST', {
                ids, fav: action === 'fav',
            });
            showToast(`已${labels[action]} ${r.changed} 条`, 'ok');
        } else if (action === 'remove') {
            const r = await api('/api/media/batch-remove', 'POST', { ids });
            showToast(`已移除 ${r.removed} 条索引`, 'ok');
        }
        app.grid.clearSelection();
        app.grid.reset();
    } catch (e) {
        showToast('批量操作失败：' + e.message, 'err');
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

/** 同步队列面板工具按钮的状态（随机/循环/清空/计数）。 */
function syncQueueTools() {
    const q = app.queue;
    if (!q) return;
    const sh = $('#queueShuffle'), md = $('#queueMode'),
          cl = $('#queueClear'), ct = $('#queueCount');
    if (sh) {
        sh.classList.toggle('on', q.shuffle);
        sh.title = q.shuffle ? '随机播放：开' : '随机播放：关';
        sh.setAttribute('aria-pressed', q.shuffle ? 'true' : 'false');
    }
    if (md) {
        md.classList.toggle('on', q.mode !== 'off');
        md.title = q.mode === 'off' ? '循环：关'
            : q.mode === 'all' ? '循环：整表' : '循环：单集';
    }
    if (cl) cl.disabled = !q.size;
    if (ct) ct.textContent = q.size ? String(q.size) : '';
}

/** 队列为空时的占位（区分「待命」与「已关闭」两种状态）。 */
function queueEmpty(q) {
    if (!q) {
        return el('div', { class: 'queue-empty' },
            el('div', { class: 'queue-empty-title' }, '队列未初始化'));
    }
    const enabled = q.enabled;
    const box = el('div', { class: 'queue-empty' },
        el('div', { class: 'queue-empty-icon' }, icon('stack', 22)),
        el('div', { class: 'queue-empty-title' }, enabled ? '连播队列已待命' : '连播已关闭'),
        el('div', { class: 'queue-empty-desc' },
            enabled
                ? '播放任意视频，将按所在目录的顺序自动生成下一集'
                : '清空队列后连播已关闭，可手动重新开启'));
    if (enabled) {
        box.append(el('button', {
            class: 'btn btn-ghost btn-sm', style: { marginTop: '10px' },
            onclick: () => { app.queue.clear(); renderQueue(); },
        }, '暂时关闭连播'));
    } else {
        box.append(el('button', {
            class: 'btn btn-ghost btn-sm', style: { marginTop: '10px' },
            onclick: async () => {
                const item = app.feed?.items[app.feed.currentIndex];
                app.queue.setEnabled(true);
                if (item) await app.queue.ensureFor(item);
                renderQueue();
                showToast('连播已开启', 'ok');
            },
        }, '按当前视频开启'));
    }
    return box;
}

function renderQueue() {
    const host = $('#queueList');
    if (!host || !app.feed) return;
    const q = app.queue;
    host.innerHTML = '';
    syncQueueTools();

    if (!q || !q.size) {
        host.append(queueEmpty(q));
        return;
    }

    q.ids.forEach((id, i) => {
        const m = q.get(id);
        if (!m) return;   // 元数据缺失：服务端解析时已剔除，正常不该出现
        const isCur = i === q.index;

        const thumb = el('div', { class: 'q-thumb' });
        if (m.poster) {
            thumb.append(el('div', { class: 'thumb-ph' }, icon('film', 16)));
            const pimg = el('img', { src: m.poster, alt: '', draggable: 'false' });
            pimg.addEventListener('load', () => { thumb.innerHTML = ''; thumb.append(pimg); });
            pimg.addEventListener('error', () => {
                pimg.remove();
                getThumbnail(m.id, m.stream).then(url => {
                    if (!url || !thumb.isConnected) return;
                    thumb.innerHTML = '';
                    thumb.append(el('img', { src: url, alt: '', draggable: 'false' }));
                });
            });
            thumb.append(pimg);
        } else {
            thumb.append(el('div', { class: 'thumb-ph' }, icon('film', 16)));
            getThumbnail(m.id, m.stream).then(url => {
                if (!url || !thumb.isConnected) return;
                thumb.innerHTML = '';
                thumb.append(el('img', { src: url, alt: '', draggable: 'false' }));
            });
        }
        if (m.duration) thumb.append(el('span', { class: 'dur' }, formatTime(m.duration)));

        const node = el('div', {
            class: `q-item ${isCur ? 'playing' : ''}`,
            draggable: 'true',
            dataset: { index: String(i) },
            onclick: () => { app.feed.jumpToQueue(m.id); },
        },
            el('span', { class: 'q-grip', 'aria-hidden': 'true' }, icon('more', 14)),
            el('span', { class: `q-pos ${isCur ? 'on' : ''}` }, String(i + 1)),
            thumb,
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
            }, heartSvg(m.is_fav)),
            el('button', {
                class: 'q-remove', 'aria-label': '从队列移除', title: '从队列移除',
                onclick: e => {
                    e.stopPropagation();
                    q.remove(m.id);
                    renderQueue();
                },
            }, icon('x', 12)));

        // 拖拽排序（队列面板只在桌面端可见，移动端不涉及触摸拖拽）
        node.addEventListener('dragstart', e => {
            e.dataTransfer.setData('text/plain', String(i));
            e.dataTransfer.effectAllowed = 'move';
            node.classList.add('q-dragging');
        });
        node.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (!node.classList.contains('q-dragging')) node.classList.add('q-drop');
        });
        node.addEventListener('dragleave', () => node.classList.remove('q-drop'));
        node.addEventListener('drop', e => {
            e.preventDefault();
            node.classList.remove('q-drop');
            const from = Number(e.dataTransfer.getData('text/plain'));
            if (Number.isNaN(from)) return;
            // 「先移除再按下标插入」对向上/向下拖都给出符合视觉的结果
            q.move(from, i);
            renderQueue();
        });
        node.addEventListener('dragend', () => {
            node.classList.remove('q-dragging');
            host.querySelectorAll('.q-drop').forEach(n => n.classList.remove('q-drop'));
        });
        host.append(node);
    });

    // 底部：队列来源 + 规模 + 模式
    const modeText = q.mode === 'off' ? '播完停止'
        : q.mode === 'all' ? '整表循环' : '单集循环';
    host.append(el('div', { class: 'queue-foot' },
        `${q.origin && q.origin !== '/' ? q.origin : '根目录'} · ${q.size} 个文件 · `
        + `${modeText}${q.shuffle ? ' · 随机' : ''}`));

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

    // ---- 数据备份：导出 / 导入（源、设置、收藏、进度）----
    const bkPw = el('input', { type: 'checkbox' });
    const bkFile = el('input', {
        type: 'file', accept: '.json,application/json',
        style: { display: 'none' },
        onchange: async e => {
            const f = e.target.files && e.target.files[0];
            e.target.value = '';           // 允许重复选同一个文件
            if (!f) return;
            try {
                const text = await f.text();
                let data;
                try { data = JSON.parse(text); }
                catch { throw new Error('不是合法的 JSON 文件'); }
                const r = await api('/api/backup/import', { method: 'POST', body: data });
                const s = r.summary || {};
                showToast(`导入完成：源 +${s.sources_added || 0} / 更新 ${s.sources_updated || 0}，`
                    + `收藏 ${s.favorites_restored || 0}，进度 ${s.progress_restored || 0}`, 'ok');
                if (s.sources_need_password) {
                    showToast(`${s.sources_need_password} 个数据源未包含密码，请手动补填`, 'warn');
                }
                if ((s.favorites_skipped || 0) + (s.progress_skipped || 0) > 0) {
                    showToast(`${(s.favorites_skipped || 0) + (s.progress_skipped || 0)} 条记录因`
                        + '媒体未扫描而跳过，扫描后可再次导入', 'warn');
                }
                await refreshSources();
                if (app.srcMgr) await app.srcMgr.load();
                if (app.feed && app.feed.items.length) app.feed.setFilter(currentSourceFilter());
            } catch (err) {
                showToast(err.message || '导入失败', 'err');
            }
        },
    });
    const bkExport = el('button', {
        class: 'btn btn-sm btn-ghost',
        onclick: async () => {
            try {
                const res = await fetch('/api/backup/export' + (bkPw.checked ? '?passwords=1' : ''));
                if (!res.ok) throw new Error(`导出失败 (${res.status})`);
                const blob = await res.blob();
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `websua-backup-${new Date().toISOString().slice(0, 19)
                    .replace(/[-:T]/g, '')}.json`;
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 1500);
                showToast('已导出配置' + (bkPw.checked ? '（含 WebDAV 密码）' : ''), 'ok');
            } catch (e) {
                showToast(e.message || '导出失败', 'err');
            }
        },
    }, '导出配置');
    const bkImport = el('button', {
        class: 'btn btn-sm btn-ghost', onclick: () => bkFile.click(),
    }, '导入配置');
    const backupRow = el('div', { class: 'backup-row' },
        bkExport, bkImport, bkFile,
        el('label', { class: 'backup-pw' }, bkPw, '导出时包含 WebDAV 密码'));

    const body = el('div', {},
        mkSwitch('autoNext', '自动连播', '播放完或出错时自动跳到下一个视频（刷视频模式）'),
        mkSwitch('resumeLast', '恢复上次播放', '打开应用时恢复上次的播放源、顺序与当前进度'),
        mkSwitch('autoPlay', '自动播放', '滚动到某个视频时自动开始播放'),
        mkSwitch('debugLog', '播放器调试日志', '在播放器「更多」菜单里提供调试日志开关'),
        el('div', { class: 'settings-sep' }),
        mkPageSelect('pageFeed', '视频流每页条数', '视频流滚动到底时每次加载的条数', [12, 24, 48, 96]),
        mkPageSelect('pageLibrary', '媒体库每页条数', '媒体库网格滚动到底每次加载的条数', [24, 48, 96, 192]),
        el('div', { class: 'settings-sep' }),
        field('数据备份', backupRow,
            '导出数据源、设置、收藏与观看进度；导入为<strong>合并</strong>模式，不会删除现有数据。'
            + '收藏/进度按「源地址 + 根路径 + 远端路径」匹配，需先扫描出对应媒体才能真正恢复。'));

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
