/**
 * 数据源管理：WebDAV 的增删改查 + 扫描控制。
 */

import { api, el, escapeHtml, formatSize, formatDate, showToast } from './utils.js';

const PRESET_COLORS = ['#6C8CFF', '#A56CFF', '#00D4C8', '#FF7A9A', '#FFB020', '#2ED47A', '#FF5C6C'];

export class SourceManager {
    constructor(root, { onChanged } = {}) {
        this.root = root;
        this.onChanged = onChanged || (() => {});
        this.sources = [];
        this.tasks = {};
        this.pollTimer = null;
        this.render();
    }

    async load() {
        try {
            const data = await api('/api/sources');
            this.sources = data.sources || [];
            this.render();
            // 有进行中/暂停中的扫描任务时自动接上轮询 ——
            // 否则刷新页面后任务状态全丢：暂停中的任务会显示成
            // 「扫描中·0文件」且永远无法从 UI 恢复/停止。
            const anyActive = this.sources.some(s => s.scan_running);
            if (anyActive) this.startPolling();
        } catch (e) {
            this.renderError(e.message);
        }
    }

    startPolling() {
        this.stopPolling();
        // 有任务在跑时才轮询，空闲不打扰服务端
        this.pollTimer = setInterval(async () => {
            try {
                const data = await api('/api/tasks');
                this.tasks = {};
                let running = false;
                // data.tasks 已按 id 降序（最新在前）；同源只取最新任务，
                // 否则历史 done 任务会覆盖当前 paused/running 状态
                for (const t of data.tasks || []) {
                    if (this.tasks[t.source_id]) continue;
                    this.tasks[t.source_id] = t;
                    if (t.state === 'pending' || t.state === 'running' || t.state === 'paused') {
                        running = true;
                    } else {
                        // 任务终结（done/cancelled/failed）：重置前端状态机，
                        // 否则 UI 会永远卡在「扫描中」
                        if (this._scanState[t.source_id] === 'scanning') {
                            this._scanState[t.source_id] = 'idle';
                        }
                    }
                }
                this.render();
                if (!running && this._wasRunning) {
                    this._wasRunning = false;
                    this.onChanged();
                    showToast('扫描完成', 'ok');
                }
                if (running) this._wasRunning = true;
                if (!running) this.stopPolling();
            } catch { this.stopPolling(); }
        }, 1500);
        this.pollTimer.unref?.();
    }

    stopPolling() {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
    }

    renderError(msg) {
        this.root.innerHTML = '';
        this.root.append(el('div', { class: 'empty' },
            el('div', { class: 'empty-icon' }, icon('!')),
            el('h3', {}, '加载失败'),
            el('p', {}, msg)));
    }

    render() {
        // 细粒度更新：扫描进行时轮询每 1.5s 全量重建 DOM，会让用户正在点的
        // 按钮瞬间销毁重建（点击落空）。所以先尝试原地更新进度，只在
        // 结构变化（源增删/启停/扫描开始结束）时才重建整卡。
        if (this._tryUpdateProgressInPlace()) return;
        this._renderFull();
    }

    /** 原地更新进行中任务的进度文字/进度条/按钮（不重建 DOM）。 */
    _tryUpdateProgressInPlace() {
        const nodes = this.root.querySelectorAll('.src-card[data-src-id]');
        if (!nodes.length || nodes.length !== this.sources.length) return false;
        for (const node of nodes) {
            const sid = Number(node.dataset.srcId);
            const s = this.sources.find(x => x.id === sid);
            const task = this.tasks[sid];
            if (!s) return false;
            const scanning = s.scan_running
                || (task && ['pending', 'running'].includes(task.state))
                || this._scanState[sid] === 'scanning';
            const paused = task && task.state === 'paused';
            const statusEl = node.querySelector('.src-status');
            if (!(scanning || paused)) {
                // 扫描结束：状态区结构要变（进度→完成/错误），必须全量重建
                return false;
            }
            if (!statusEl || !statusEl.querySelector('.scan-bar')) return false;
            const found = task?.found ?? 0;
            const folders = task?.folders ?? 0;
            const pct = Math.min(92, 8 + folders * 1.5);
            const bar = statusEl.querySelector('.scan-bar-real i');
            if (bar) bar.style.width = pct + '%';
            const text = statusEl.querySelector('.src-status-text');
            if (text) {
                text.textContent = paused
                    ? `已暂停 · 已遍历 ${folders} 目录 · 已发现 ${found} 个文件`
                    : `扫描中 · 已遍历 ${folders} 目录 · 已发现 ${found} 个文件`;
            }
            const pathEl = statusEl.querySelector('.src-status-path');
            if (pathEl && task?.current) pathEl.textContent = `当前：${task.current}`;
            // 暂停/继续按钮文字切换
            const pauseBtn = statusEl.querySelector('.src-status-ctl button');
            if (pauseBtn) {
                const want = paused ? '继续' : '暂停';
                const ico = pauseBtn.querySelector('svg');
                if (!pauseBtn.textContent.includes(want)) {
                    pauseBtn.innerHTML = '';
                    if (ico) pauseBtn.append(ico);
                    pauseBtn.append(want);
                }
            }
        }
        return true;
    }

    _renderFull() {
        this.root.innerHTML = '';
        const wrap = el('div', { class: 'sources-wrap' });

        wrap.append(el('div', { class: 'section-head' },
            el('div', {},
                el('div', { class: 'section-title' }, '数据源'),
                el('div', { class: 'section-desc' },
                    '每个 WebDAV 作为一个独立文件源，扫描后即可在「视频流」中连续播放')),
            el('div', { style: { display: 'flex', gap: '8px' } },
                el('button', {
                    class: 'btn btn-ghost btn-sm',
                    onclick: () => this.scanAll(),
                }, '全部扫描'),
                el('button', {
                    class: 'btn btn-primary btn-sm',
                    onclick: () => this.openEditor(null),
                }, '+ 添加数据源'))));

        if (!this.sources.length) {
            wrap.append(el('div', {
                class: 'empty',
                style: { border: '1px dashed var(--line-2)', borderRadius: 'var(--r-xl)' },
            },
                el('div', { class: 'empty-icon' }, icon('cloud', 30)),
                el('h3', {}, '还没有数据源'),
                el('p', {}, '添加一个 WebDAV 地址（Nextcloud、ownCloud、群晖、坚果云等都支持），扫描后视频会出现在「视频流」里。'),
                el('button', {
                    class: 'btn btn-primary', style: { marginTop: '8px' },
                    onclick: () => this.openEditor(null),
                }, '添加第一个数据源')));
            this.root.append(wrap);
            return;
        }

        const grid = el('div', { class: 'src-grid' });
        for (const s of this.sources) {
            const card = this._card(s);
            card.dataset.srcId = String(s.id);
            grid.append(card);
        }
        wrap.append(grid);
        this.root.append(wrap);
    }

    _card(s) {
        const task = this.tasks[s.id];
        const scanSt = this._scanState[s.id] || 'idle';
        const scanning = s.scan_running
            || (task && (task.state === 'pending' || task.state === 'running'))
            || scanSt === 'scanning';
        const paused = task && task.state === 'paused';
        const probing = scanSt === 'probing';
        const counts = s.counts || {};
        const accent = s.color || 'var(--brand-1)';
        const busy = scanning || probing;

        const card = el('div', {
            class: `src-card ${busy ? 'is-busy' : ''} ${s.enabled ? '' : 'is-off'}`,
            style: { '--accent': accent },
        });

        // ---- 头部：头像 + 名称/完整地址/根目录 + 启停开关 ----
        const head = el('div', { class: 'src-card-head' });
        head.append(el('div', { class: 'src-avatar', style: { background: accent } },
            icon('server', 18)));

        const idBox = el('div', { class: 'src-card-id' });
        const nameRow = el('div', { class: 'src-card-name' },
            el('span', { class: 'src-name-text', title: s.name }, s.name),
            s.username
                ? el('span', { class: 'pill pill-auth', title: '已配置账号认证' }, '🔒 认证')
                : el('span', { class: 'pill pill-anon' }, '匿名'));
        if (s.tg_mode) nameRow.append(el('span', { class: 'pill pill-tg', title: '已开启 TG 导出封面识别' }, 'TG 封面'));
        if (!s.enabled) nameRow.append(el('span', { class: 'pill pill-off' }, '停用'));
        idBox.append(nameRow);
        // 完整地址（含协议），左对齐、可换行、超长截断
        idBox.append(el('div', { class: 'src-url', title: s.base_url },
            el('span', { class: 'src-url-label' }, '地址 '),
            el('span', {}, s.base_url)));
        if (s.root_path && s.root_path !== '/') {
            idBox.append(el('div', { class: 'src-url', title: s.root_path },
                el('span', { class: 'src-url-label' }, '根目录 '),
                el('span', {}, s.root_path)));
        }
        head.append(idBox);

        const sw = el('label', { class: 'src-switch', title: s.enabled ? '点击停用' : '点击启用' });
        const cb = el('input', { type: 'checkbox' });
        cb.checked = !!s.enabled;
        cb.addEventListener('change', async () => {
            const on = cb.checked;
            try {
                await api(`/api/sources/${s.id}`, { method: 'PUT', body: { enabled: on } });
                showToast(on ? '已启用' : '已停用', 'ok');
                if (!on) this.invalidateProbe(s.id);
                await this.load();
                this.onChanged();
            } catch (err) {
                cb.checked = !on;
                showToast(err.message, 'err');
            }
        });
        sw.append(cb, el('span', { class: 'src-switch-track' }));
        head.append(sw);
        card.append(head);

        // ---- 统计：四格左对齐（视频/图片/音频/总大小）----
        const stats = el('div', { class: 'src-stats' },
            this._stat(counts.video ?? 0, '视频'),
            this._stat(counts.image ?? 0, '图片'),
            this._stat(counts.audio ?? 0, '音频'),
            this._stat(formatSize(counts.size_total || 0), '总大小'));
        card.append(stats);

        // ---- 上次扫描信息 ----
        const scanline = el('div', { class: 'src-scanline' },
            el('span', { class: 'src-scanline-k' }, '上次扫描'),
            el('span', { class: 'src-scanline-v' },
                s.last_scan_at ? formatDate(s.last_scan_at) : '从未'));
        if (s.last_scan_ms) {
            scanline.append(el('span', { class: 'src-scanline-ms' },
                `· ${((s.last_scan_ms / 1000) || 0).toFixed(1)}s`));
        }
        card.append(scanline);

        // ---- 状态区：错误 / 探测中 / 扫描进度（含暂停/继续/停止 + 日志）----
        const status = this._statusArea(s, { task, scanning, probing, paused });
        if (status) card.append(status);

        // ---- 操作行：主操作 + 更多菜单 ----
        card.append(this._actionBar(s, { busy, scanning, probing, paused, task }));

        return card;
    }

    _stat(v, label) {
        return el('div', { class: 'src-stat' },
            el('b', {}, String(v ?? 0)),
            el('span', {}, label));
    }

    _statusArea(s, { task, scanning, probing, paused }) {
        if (probing) {
            return el('div', { class: 'src-status src-status-probe' },
                el('span', { class: 'src-status-spin' }),
                el('span', {}, '正在检测连通性…'));
        }
        if (scanning || paused) {
            const found = task?.found ?? 0;
            const folders = task?.folders ?? 0;
            // 真实进度：按已遍历目录数推进（总数未知，封顶 92% 表示「仍在进行」）
            const pct = Math.min(92, 8 + folders * 1.5);

            const barWrap = el('div', { class: 'src-status' },
                el('div', { class: 'scan-bar scan-bar-real' },
                    el('i', { style: { width: pct + '%' } })),
                el('div', { class: 'src-status-text' },
                    paused
                        ? `已暂停 · 已遍历 ${folders} 目录 · 已发现 ${found} 个文件`
                        : `扫描中 · 已遍历 ${folders} 目录 · 已发现 ${found} 个文件`),
                task?.current && !paused ? el('div', {
                    class: 'src-status-path', title: task.current,
                }, `当前：${task.current}`) : null);

            // 控制按钮行：暂停/继续 + 停止 + 日志
            const controls = el('div', { class: 'src-status-ctl' },
                el('button', {
                    class: 'btn btn-sm btn-ghost',
                    onclick: () => this._controlScan(s.id, paused ? 'resume' : 'pause'),
                },
                    icon(paused ? 'play' : 'pause', 13),
                    paused ? '继续' : '暂停'),
                el('button', {
                    class: 'btn btn-sm btn-ghost btn-danger',
                    onclick: () => this._controlScan(s.id, 'cancel'),
                }, icon('stop', 13), '停止'),
                el('button', {
                    class: 'btn btn-sm btn-ghost',
                    onclick: () => this._viewLog(s, task),
                }, icon('log', 13), '日志'));
            barWrap.append(controls);
            return barWrap;
        }
        if (task?.state === 'cancelled') {
            return el('div', { class: 'src-status src-status-err' },
                icon('stop', 14),
                el('span', { class: 'src-status-text' }, '扫描已停止（本次结果未保存）'));
        }
        if (task?.state === 'failed' || s.last_error) {
            const msg = task?.state === 'failed'
                ? (task.error || '扫描失败')
                : (s.last_error || '');
            return el('div', {
                class: 'src-status src-status-err',
                title: msg,
            },
                icon('alert', 14),
                el('span', { class: 'src-status-text' }, msg.length > 90 ? msg.slice(0, 90) + '…' : msg));
        }
        if (task?.state === 'done') {
            const failed = task.failed_dirs || 0;
            return el('div', { class: `src-status ${failed ? 'src-status-warn' : 'src-status-ok'}` },
                icon(failed ? '!' : 'check', 14),
                el('span', { class: 'src-status-text' },
                    `扫描完成 · ${task.total ?? 0} 个文件 · ${((task.elapsed_ms ?? 0) / 1000).toFixed(1)}s`
                    + (failed ? ` · ⚠ ${failed} 个目录失败被跳过（详见日志，建议重扫）` : '')));
        }
        return null;
    }

    async _controlScan(id, action) {
        // 乐观更新：立即切换 UI，不等后端确认。后端确认要等扫描线程
        // 走到下一个检查点（限流间隔/网络重试时可达数秒），不乐观的话
        // 用户会觉得「点了没反应」而连点。失败时靠轮询拉回真实状态。
        if (this.tasks[id] && (action === 'pause' || action === 'resume')) {
            this.tasks[id] = {
                ...this.tasks[id],
                state: action === 'pause' ? 'paused' : 'running',
            };
            this.render();
        }
        try {
            await api(`/api/sources/${id}/scan/${action}`, { method: 'POST' });
            if (action === 'pause') showToast('已暂停', 'warn');
            else if (action === 'resume') showToast('已继续', 'ok');
            else showToast('正在停止…', 'warn');
            // 拉一次真实任务状态校正（乐观值可能有偏差）
            try {
                const d = await api('/api/tasks');
                this.tasks = {};
                for (const t of d.tasks || []) {
                    if (!this.tasks[t.source_id]) this.tasks[t.source_id] = t;
                }
            } catch { /* 轮询会兜底 */ }
            this.startPolling();
            await this.load();
        } catch (e) {
            showToast(e.message, 'err');
            // 失败时立即拉真实状态，校正乐观值
            this.startPolling();
            await this.load();
        }
    }

    _viewLog(s, task) {
        const lines = task?.logs || [];
        const body = el('div', {});
        if (!lines.length) {
            body.append(el('div', { style: { color: 'var(--fg-3)', fontSize: '13px' } },
                '暂无日志。'));
        } else {
            const pre = el('div', {
                class: 'src-log-view',
            });
            pre.textContent = lines.join('\n');
            body.append(pre);
        }
        openModal({
            title: `扫描日志 · ${s.name}`,
            body,
            actions: [
                {
                    label: '复制日志',
                    onClick: () => {
                        navigator.clipboard?.writeText((task?.logs || []).join('\n'));
                        showToast('已复制', 'ok');
                        return false;
                    },
                },
                { label: '关闭', primary: true },
            ],
        });
    }

    _actionBar(s, { busy, scanning, probing, paused, task }) {
        const bar = el('div', { class: 'src-actions' });

        bar.append(el('button', {
            class: 'btn btn-sm btn-primary src-scan-btn',
            disabled: busy,
            onclick: () => this.scan(s.id),
        },
            busy
                ? el('span', { class: 'btn-spinner' })
                : icon('scan', 14),
            busy ? (probing ? '检测中…' : '扫描中…') : '扫描'));

        // 次要操作折叠进「更多」：编辑 / 测试连接 / 日志 / 删除
        const moreWrap = el('div', { class: 'src-more' });
        const moreBtn = el('button', {
            class: 'btn btn-sm btn-icon btn-ghost',
            'aria-label': '更多操作',
            disabled: probing,
            onclick: e => {
                e.stopPropagation();
                const open = moreMenu.classList.toggle('open');
                moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
                if (open) {
                    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
                }
            },
        }, icon('more', 16));
        const moreMenu = el('div', { class: 'src-more-menu' },
            el('button', {
                class: 'src-more-item',
                onclick: e => { e.stopPropagation(); closeMenu(); this.probe(s); },
            }, icon('wifi', 14), '测试连接'),
            el('button', {
                class: 'src-more-item',
                onclick: e => { e.stopPropagation(); closeMenu(); this.openEditor(s); },
            }, icon('stack', 14), '编辑'),
            el('button', {
                class: 'src-more-item',
                onclick: e => { e.stopPropagation(); closeMenu(); this._viewLog(s, task); },
            }, icon('log', 14), '查看日志'),
            el('div', { class: 'src-more-sep' }),
            el('button', {
                class: 'src-more-item src-more-danger',
                disabled: scanning,
                onclick: e => { e.stopPropagation(); closeMenu(); this.remove(s); },
            }, icon('trash', 14), '删除'));
        const closeMenu = () => {
            moreMenu.classList.remove('open');
            moreBtn.setAttribute('aria-expanded', 'false');
        };
        moreWrap.append(moreBtn, moreMenu);
        bar.append(moreWrap);

        return bar;
    }

    /**
     * 扫描状态机（每个源独立）：
     *   idle → probing → scanning → done | failed
     *          ↓(连通性失败)→ idle（不开扫，直接报错）
     * probe 结果缓存 60s，避免「全部扫描」时逐个重复握手。
     */
    _scanState = {};    // id -> 'idle' | 'probing' | 'scanning'
    _probeCache = {};   // id -> { ok, at, error }

    async scan(id) {
        const st = this._scanState[id] || 'idle';
        if (st !== 'idle') return;               // 正在探测/扫描中，忽略重复点击

        // 1) 先确认连通性 —— 密码错/地址错在这里就暴露，不用等扫描失败
        this._scanState[id] = 'probing';
        this.render();
        const probe = await this._probe(id);
        if (!probe.ok) {
            this._scanState[id] = 'idle';
            this.render();
            showToast(`无法连接，已取消扫描：${probe.error}`, 'err');
            return;
        }

        // 2) 连通才真正开扫
        this._scanState[id] = 'scanning';
        this.render();
        try {
            await api(`/api/sources/${id}/scan`, { method: 'POST' });
            this.startPolling();
            await this.load();
        } catch (e) {
            this._scanState[id] = 'idle';
            showToast(e.message, 'err');
        }
        this.render();
    }

    async scanAll() {
        const ids = this.sources.filter(s => s.enabled).map(s => s.id);
        if (!ids.length) { showToast('没有已启用的数据源', 'warn'); return; }
        showToast(`正在检测 ${ids.length} 个数据源…`);
        let okCount = 0;
        const toScan = [];
        for (const id of ids) {
            if ((this._scanState[id] || 'idle') !== 'idle') continue;
            const probe = await this._probe(id);
            if (probe.ok) toScan.push(id);
            else showToast(`「${this._nameOf(id)}」连接失败，已跳过：${probe.error}`, 'err');
        }
        if (!toScan.length) { showToast('没有可扫描的数据源', 'warn'); return; }
        await Promise.allSettled(
            toScan.map(id => api(`/api/sources/${id}/scan`, { method: 'POST' })));
        toScan.forEach(id => this._scanState[id] = 'scanning');
        this.startPolling();
        await this.load();
        showToast(`已开始扫描 ${toScan.length}/${ids.length} 个数据源`, 'ok');
    }

    _nameOf(id) { return this.sources.find(s => s.id === id)?.name || `#${id}`; }

    async _probe(id) {
        const cached = this._probeCache[id];
        if (cached && Date.now() - cached.at < 60_000) return cached;
        try {
            await api(`/api/sources/${id}/probe`, { method: 'POST', body: {} });
            const r = { ok: true, at: Date.now(), error: '' };
            this._probeCache[id] = r;
            return r;
        } catch (e) {
            const r = { ok: false, at: Date.now(), error: e.message };
            this._probeCache[id] = r;
            return r;
        }
    }

    invalidateProbe(id) { delete this._probeCache[id]; }

    async probe(s) {
        showToast('正在连接…');
        try {
            const data = await api(`/api/sources/${s.id}/probe`, { method: 'POST', body: s });
            this.invalidateProbe(s.id);
            this._showProbe(s, data);
        } catch (e) {
            showToast('连接失败：' + e.message, 'err');
        }
    }

    _showProbe(s, data) {
        const rows = [];
        rows.push(['状态', '连接成功']);
        rows.push(['根目录条目', String(data.total ?? 0)]);
        if (data.folders?.length) rows.push(['子目录', data.folders.slice(0, 5).join('、')]);
        if (data.files?.length) {
            rows.push(['文件样例', data.files.slice(0, 3).map(f => `${f.name}(${formatSize(f.size)})`).join('、')]);
        }
        openModal({
            title: `连接测试 · ${s.name}`,
            body: el('div', {},
                rows.map(([k, v]) => el('div', { class: 'cvp-info-row', style: { color: 'var(--fg-0)' } },
                    el('span', { style: { color: 'var(--fg-2)' } }, k),
                    el('span', { style: { color: 'var(--fg-0)' } }, v))),
                el('div', { style: { marginTop: '14px', fontSize: '12px', color: 'var(--fg-2)' } },
                    '注意：部分服务器在 PROPFIND 深度 1 下不返回子目录，此时扫描会逐层下钻，仍可正常工作。')),
            actions: [{ label: '知道了', primary: true }],
        });
    }

    openEditor(s) {
        const isNew = !s;
        const state = {
            name: s?.name || '',
            base_url: s?.base_url || '',
            username: s?.username || '',
            password: '',
            root_path: s?.root_path || '/',
            color: s?.color || PRESET_COLORS[0],
            enabled: s ? !!s.enabled : true,
            auto_scan: s ? !!s.auto_scan : false,
            tg_mode: s ? !!s.tg_mode : false,
            exclude_dirs: s?.exclude_dirs || '',
        };

        const fName = field('名称', el('input', {
            type: 'text', value: state.name, placeholder: '例如：我的网盘',
            oninput: e => state.name = e.target.value,
        }), '只用于本地显示，随意起名');

        const fUrl = field('WebDAV 地址', el('input', {
            type: 'text', value: state.base_url, placeholder: 'https://example.com/dav',
            oninput: e => state.base_url = e.target.value.trim(),
        }), 'Nextcloud：<code>/remote.php/dav/files/用户名</code>；ownCloud：<code>/remote.php/webdav</code>');

        const fRoot = field('根目录', el('input', {
            type: 'text', value: state.root_path, placeholder: '/',
            oninput: e => state.root_path = e.target.value || '/',
        }), '留空或填 / 表示扫描整个地址；也可以填子目录如 <code>/视频</code>');

        const row = el('div', { class: 'field-row' },
            field('用户名', el('input', {
                type: 'text', value: state.username, placeholder: '可留空',
                oninput: e => state.username = e.target.value,
            })),
            field('密码', el('input', {
                type: 'password', value: '',
                placeholder: s?.has_password ? '已保存，留空则不修改' : '可留空',
                oninput: e => state.password = e.target.value,
            })));

        const colorRow = el('div', { class: 'color-row' },
            ...PRESET_COLORS.map(c => el('button', {
                class: `color-dot ${state.color === c ? 'active' : ''}`,
                style: { background: c },
                onclick: e => {
                    state.color = c;
                    e.currentTarget.parentElement.querySelectorAll('.color-dot')
                        .forEach(x => x.classList.remove('active'));
                    e.currentTarget.classList.add('active');
                },
            })));
        const fColor = field('标识色', colorRow, '用于在列表里区分来源');
        const fExclude = field('排除目录', el('input', {
            type: 'text', value: state.exclude_dirs, placeholder: '例如：抢救（不含文件）,临时',
            oninput: e => state.exclude_dirs = e.target.value,
        }), '扫描时跳过这些名字的文件夹（逗号分隔，只匹配目录名，中英文逗号均可）');

        const swEnabled = switchRow('启用', '停用后不参与扫描与播放', state.enabled, v => state.enabled = v);
        const swAuto = switchRow('自动扫描', '每次启动程序时自动扫描一遍', state.auto_scan, v => state.auto_scan = v);
        const swTg = switchRow('TG 导出封面', 'Telegram 导出的视频带同名 .jpg 封面，开启后扫描时自动关联为缩略图', state.tg_mode, v => state.tg_mode = v);

        const body = el('div', {}, fName, fUrl, fRoot, row, fColor, fExclude, swEnabled, swAuto, swTg);

        const modal = openModal({
            title: isNew ? '添加数据源' : '编辑数据源',
            body,
            actions: [
                { label: '取消' },
                {
                    label: isNew ? '测试并添加' : '保存',
                    primary: true,
                    keepOpen: true,
                    onClick: async (btn, close) => {
                        if (!state.name.trim()) { showToast('请填写名称', 'err'); return false; }
                        if (!state.base_url.trim()) { showToast('请填写地址', 'err'); return false; }
                        btn.disabled = true;
                        btn.textContent = '处理中…';
                        try {
                            if (isNew) {
                                await api('/api/sources', { method: 'POST', body: { ...state } });
                                showToast('数据源已添加', 'ok');
                                close();
                                await this.load();
                                this.onChanged();
                                // 新加的立刻扫一次，省得用户再点
                                const fresh = this.sources[this.sources.length - 1];
                                if (fresh) { await this.scan(fresh.id); }
                            } else {
                                const payload = { ...state };
                                if (!payload.password) delete payload.password;
                                await api(`/api/sources/${s.id}`, { method: 'PUT', body: payload });
                                showToast('已保存', 'ok');
                                close();
                                await this.load();
                                this.onChanged();
                            }
                            return true;
                        } catch (e) {
                            showToast(e.message, 'err');
                            btn.disabled = false;
                            btn.textContent = isNew ? '测试并添加' : '保存';
                            return false;
                        }
                    },
                },
            ],
        });
        return modal;
    }

    async remove(s) {
        openModal({
            title: '删除数据源',
            body: el('p', { style: { fontSize: '13.5px', color: 'var(--fg-1)' } },
                `确定删除「${escapeHtml(s.name)}」吗？`,
                el('br'),
                el('span', { style: { color: 'var(--fg-3)' } },
                    '该源已索引的媒体文件记录会一并清除，远端文件本身不受影响。')),
            actions: [
                { label: '取消' },
                {
                    label: '删除', danger: true,
                    onClick: async () => {
                        try {
                            await api(`/api/sources/${s.id}`, { method: 'DELETE' });
                            showToast('已删除', 'ok');
                            await this.load();
                            this.onChanged();
                            return true;
                        } catch (e) { showToast(e.message, 'err'); return false; }
                    },
                },
            ],
        });
    }
}

/* ---------- 复用组件 ---------- */
export function field(label, input, hint) {
    return el('div', { class: 'field' },
        el('label', {}, label),
        input,
        hint ? el('div', { class: 'hint', html: hint }) : null);
}

export function switchRow(title, desc, initial, onChange) {
    const sw = el('div', { class: `switch ${initial ? 'on' : ''}` });
    sw.addEventListener('click', () => {
        sw.classList.toggle('on');
        onChange(sw.classList.contains('on'));
    });
    return el('div', { class: 'switch-row' },
        el('div', { class: 'switch-label' }, el('b', {}, title), el('span', {}, desc)),
        sw);
}

export function openModal({ title, body, actions = [{ label: '关闭', primary: true }] }) {
    const mask = el('div', { class: 'modal-mask' });
    const modal = el('div', { class: 'modal' });
    const close = () => {
        mask.remove();
        document.removeEventListener('keydown', onKey);
    };
    const onKey = e => {
        if (e.key === 'Escape') close();
    };

    modal.append(
        el('div', { class: 'modal-head' },
            el('div', { class: 'modal-title' }, title),
            el('button', { class: 'icon-btn', 'aria-label': '关闭', onclick: close }, icon('x'))),
        el('div', { class: 'modal-body' }, body),
    );

    const foot = el('div', { class: 'modal-foot' });
    actions.forEach(a => {
        const btn = el('button', {
            class: `btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''}`,
            onclick: async () => {
                if (a.onClick) {
                    const r = await a.onClick(btn, close);
                    if (r === false) return;
                }
                if (!a.keepOpen) close();
            },
        }, a.label);
        foot.append(btn);
    });
    modal.append(foot);

    mask.append(modal);
    mask.addEventListener('click', e => { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(mask);
    setTimeout(() => modal.querySelector('input,select,button')?.focus(), 60);
    return { close, modal };
}

export function icon(name, size = 18, className = '') {
    const paths = {
        x: 'M18 6L6 18M6 6l12 12',
        cloud: 'M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z',
        eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z|M12 15a3 3 0 100-6 3 3 0 000 6z',
        'eye-off': 'M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24M1 1l22 22',
        plus: 'M12 5v14M5 12h14',
        search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35',
        play: 'M5 3l14 9-14 9V3z',
        grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
        stack: 'M4 6h16M4 12h16M4 18h16',
        server: 'M4 4h16v6H4zM4 14h16v6H4z|M7 7h.01M7 17h.01',
        sun: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
        moon: 'M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z',
        auto: 'M12 3a9 9 0 109 9M12 3v3M12 3l-2.5 2.5M21 12h-3M21 12l-2.5-2.5',
        menu: 'M3 12h18M3 6h18M3 18h18',
        refresh: 'M23 4v6h-6M1 20v-6h6|M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15',
        trash: 'M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6',
        star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
        info: 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-4M12 8h.01',
        folder: 'M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z',
        home: 'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z',
        film: 'M4 3h16a1 1 0 011 1v16a1 1 0 01-1 1H4a1 1 0 01-1-1V4a1 1 0 011-1zM7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4',
        download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
        copy: 'M20 9h-9a2 2 0 00-2 2v9a2 2 0 002 2h9a2 2 0 002-2v-9a2 2 0 00-2-2zM5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1',
        more: 'M5 12h.01M12 12h.01M19 12h.01',
        chevron: 'M6 9l6 6 6-6',
        chevronUp: 'M18 15l-6-6-6 6',
        link: 'M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71',
        wifi: 'M5 12.55a11 11 0 0114.08 0M1.42 9a16 16 0 0121.16 0M8.53 16.11a6 6 0 016.95 0M12 20h.01',
        alert: 'M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0zM12 9v4M12 17h.01',
        check: 'M20 6L9 17l-5-5',
        scan: 'M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2M3 12h18',
        image: 'M19 3H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5a2 2 0 00-2-2zM8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM21 15l-5-5L5 21',
        music: 'M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM21 16a3 3 0 11-6 0 3 3 0 016 0z',
        settings: 'M12 15a3 3 0 100-6 3 3 0 000 6z|M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z',
        log: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5',
        next: 'M5 4l10 8-10 8V4zM19 4h2v16h-2z',
        pause: 'M8 5h3v14H8zM13 5h3v14h-3z',
        stop: 'M6 6h12v12H6z',
        '!': 'M12 22a10 10 0 100-20 10 10 0 000 20zM12 8v4M12 16h.01',
    };
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    if (className) svg.setAttribute('class', className);
    for (const d of (paths[name] || '').split('|')) {
        const p = document.createElementNS(ns, 'path');
        p.setAttribute('d', d);
        svg.append(p);
    }
    return svg;
}
