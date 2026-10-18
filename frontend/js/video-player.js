/**
 * 自定义播放器（Telegram 风格）—— 基于你的半成品改造。
 *
 * 与原版的差异：
 *  1. 去掉了 showToast / escapeHtml / probeMediaFailure 的外部依赖 —— 改为从 utils.js 引入
 *  2. 观看进度从服务端读写（原来走 user-state.js 的 Telegram 消息 ID，这里换成 media id）
 *  3. 新增「翻页」回调 onEnded，由竖屏流负责切换下一条
 *  4. 信息面板改为请求 /api/media/{id}
 *  5. 移除调试日志浮窗的拖拽持久化冲突，改为跟随容器
 *  6. 保留原有三条看门狗（加载超时 / 停滞 / 卡死重试）与端点回退机制
 */

import { showToast, escapeHtml, probeMediaFailure, formatTime } from './utils.js';
import { getPosition, setPosition, clearPosition, pushProgress } from './progress.js';

let activePlayer = null;

export function createVideoPlayer(container, url, options = {}) {
    // ---- 记录上一个播放器的状态，供新播放器参考 ----
    const hadOldPlayer = !!activePlayer;
    let oldPlayerInfo = null;
    if (hadOldPlayer) {
        const v = activePlayer.video;
        oldPlayerInfo = {
            wasPlaying: !v.paused,
            pos: v.currentTime,
            duration: v.duration,
        };
    }
    destroyActivePlayer();

    const mediaId = options.mediaId || 0;
    const title = options.title || '视频';
    // 调试日志默认关闭：只有显式传 debug:true 才开。
    // 面板始终渲染但默认隐藏，通过「更多」菜单里的「调试日志」开关。
    const debug = options.debug === true;

    const state = {
        playing: false, muted: false, volume: 1, speed: 1, loop: false,
        fullscreen: false, controlsVisible: true, controlsTimer: null,
        pipSupported: document.pictureInPictureEnabled,
        rotation: 0, durationReady: false, posterImg: null,
    };

    const posterAttr = options.poster ? ` poster="${escapeHtml(options.poster)}"` : '';
    const loopAttr = options.loop ? ' loop' : '';
    if (options.loop) state.loop = true;
    const autoplayAttr = options.autoplay ? ' autoplay' : '';
    if (options.autoplay) state.muted = true;
    const fallbackUrl = options.fallbackUrl || null;

    container.innerHTML = `
        <div class="cvp-wrapper">
            <video class="cvp-video" preload="auto" playsinline${posterAttr}${loopAttr}${autoplayAttr}></video>
            <div class="cvp-loading-overlay">
                <div class="cvp-loading-spinner"></div>
                <div class="cvp-loading-text">加载中...</div>
                <div class="cvp-loading-detail"></div>
                <div class="cvp-loading-bar"><div class="cvp-loading-bar-fill"></div></div>
                <button class="cvp-loading-retry" style="display:none">重试</button>
            </div>
            <div class="cvp-controls">
                <div class="cvp-controls-top">
                    <div class="cvp-rotate-group">
                        <button class="cvp-btn cvp-rotate-btn cvp-btn-tooltip-down" data-tooltip="旋转" aria-label="旋转" aria-haspopup="true" aria-expanded="false">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                        </button>
                        <div class="cvp-rotate-menu">
                            <button class="cvp-rotate-option" type="button" data-deg="-90">向左旋转</button>
                            <button class="cvp-rotate-option" type="button" data-deg="90">向右旋转</button>
                        </div>
                    </div>
                    <button class="cvp-btn cvp-pip-btn cvp-btn-tooltip-down" data-tooltip="画中画" aria-label="画中画">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><rect x="11" y="9" width="9" height="7" rx="1" fill="currentColor" opacity="0.3"/></svg>
                    </button>
                </div>
                <div class="cvp-controls-center">
                    <button class="cvp-btn cvp-seek-back" data-tooltip="后退10秒" aria-label="后退10秒">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/><text x="12" y="16" text-anchor="middle" fill="currentColor" stroke="none" font-size="7" font-weight="600">10</text></svg>
                    </button>
                    <button class="cvp-btn cvp-play-btn" aria-label="播放">
                        <svg class="cvp-icon-play" width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>
                        <svg class="cvp-icon-pause" width="36" height="36" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg>
                    </button>
                    <button class="cvp-btn cvp-replay-btn" data-tooltip="重播" aria-label="重播" style="display:none">
                        <svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>
                    </button>
                    <button class="cvp-btn cvp-seek-forward" data-tooltip="前进10秒" aria-label="前进10秒">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/><text x="12" y="16" text-anchor="middle" fill="currentColor" stroke="none" font-size="7" font-weight="600">10</text></svg>
                    </button>
                </div>
                <div class="cvp-controls-bottom">
                    <div class="cvp-time">0:00 / 0:00</div>
                    <div class="cvp-progress">
                        <div class="cvp-progress-buffered"></div>
                        <div class="cvp-progress-played"></div>
                        <div class="cvp-progress-thumb"></div>
                        <div class="cvp-progress-tooltip"></div>
                    </div>
                    <div class="cvp-bottom-right">
                        <div class="cvp-speed-group">
                            <button class="cvp-btn cvp-speed-btn">1x</button>
                            <div class="cvp-speed-menu">
                                <div class="cvp-speed-option" data-speed="0.25">0.25x</div>
                                <div class="cvp-speed-option" data-speed="0.5">0.5x</div>
                                <div class="cvp-speed-option" data-speed="0.75">0.75x</div>
                                <div class="cvp-speed-option cvp-speed-active" data-speed="1">正常</div>
                                <div class="cvp-speed-option" data-speed="1.5">1.5x</div>
                                <div class="cvp-speed-option" data-speed="2">2x</div>
                                <div class="cvp-speed-option" data-speed="3">3x</div>
                            </div>
                        </div>
                        <div class="cvp-volume-group">
                            <button class="cvp-btn cvp-mute-btn" data-tooltip="静音" aria-label="静音">
                                <svg class="cvp-icon-vol" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
                                <svg class="cvp-icon-muted" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>
                            </button>
                            <div class="cvp-volume-slider">
                                <div class="cvp-volume-track"><div class="cvp-volume-fill"></div></div>
                            </div>
                        </div>
                        <button class="cvp-btn cvp-fullscreen-btn" data-tooltip="全屏" aria-label="全屏">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
                        </button>
                        <div class="cvp-more-group">
                            <button class="cvp-btn cvp-more-btn" data-tooltip="更多" aria-label="更多" aria-haspopup="true" aria-expanded="false">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
                            </button>
                            <div class="cvp-more-menu">
                                <button class="cvp-more-option cvp-more-loop-option" type="button">循环播放</button>
                                <button class="cvp-more-option cvp-more-shot-option" type="button">截图</button>
                                <button class="cvp-more-option cvp-more-download-option" type="button">下载</button>
                                <button class="cvp-more-option cvp-more-link-option" type="button">复制直链</button>
                                <button class="cvp-more-option cvp-more-info-option" type="button">视频信息</button>
                                <button class="cvp-more-option cvp-more-debug-option" type="button">调试日志</button>
                            </div>
                            <div class="cvp-info-panel">
                                <div class="cvp-info-title">视频信息</div>
                                <div class="cvp-info-body"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="cvp-tap-indicator cvp-tap-left"></div>
            <div class="cvp-tap-indicator cvp-tap-right"></div>
            <div class="cvp-debug-log cvp-debug-hidden">
                <div class="cvp-debug-log-header">
                    <span class="cvp-debug-log-collapse">+</span>
                    <span class="cvp-debug-log-title">调试日志</span>
                    <button class="cvp-debug-log-copy" title="复制全部日志">复制</button>
                </div>
                <div class="cvp-debug-log-entries"></div>
            </div>
        </div>
    `;

    const q = sel => container.querySelector(sel);
    const video = q('.cvp-video');
    const wrapper = q('.cvp-wrapper');
    const controls = q('.cvp-controls');
    const loadingOverlay = q('.cvp-loading-overlay');
    const loadingText = q('.cvp-loading-text');
    const loadingDetail = q('.cvp-loading-detail');
    const loadingBarFill = q('.cvp-loading-bar-fill');
    const playBtn = q('.cvp-play-btn');
    const iconPlay = q('.cvp-icon-play');
    const iconPause = q('.cvp-icon-pause');
    const timeEl = q('.cvp-time');
    const progress = q('.cvp-progress');
    const progressPlayed = q('.cvp-progress-played');
    const progressBuffered = q('.cvp-progress-buffered');
    const progressThumb = q('.cvp-progress-thumb');
    const speedBtn = q('.cvp-speed-btn');
    const speedMenu = q('.cvp-speed-menu');
    const muteBtn = q('.cvp-mute-btn');
    const iconVol = q('.cvp-icon-vol');
    const iconMuted = q('.cvp-icon-muted');
    const volumeSlider = q('.cvp-volume-slider');
    const volumeFill = q('.cvp-volume-fill');
    const fullscreenBtn = q('.cvp-fullscreen-btn');
    const pipBtn = q('.cvp-pip-btn');
    const rotateBtn = q('.cvp-rotate-btn');
    const rotateMenu = q('.cvp-rotate-menu');
    const seekBack = q('.cvp-seek-back');
    const seekForward = q('.cvp-seek-forward');
    const replayBtn = q('.cvp-replay-btn');
    const moreBtn = q('.cvp-more-btn');
    const moreMenu = q('.cvp-more-menu');
    const moreLoopOption = q('.cvp-more-loop-option');
    const moreShotOption = q('.cvp-more-shot-option');
    const moreDownloadOption = q('.cvp-more-download-option');
    const moreLinkOption = q('.cvp-more-link-option');
    const moreInfoOption = q('.cvp-more-info-option');
    const infoPanel = q('.cvp-info-panel');
    const infoBody = q('.cvp-info-body');
    const retryBtn = q('.cvp-loading-retry');
    const tooltip = q('.cvp-progress-tooltip');
    const tapLeft = q('.cvp-tap-left');
    const tapRight = q('.cvp-tap-right');

    /* ---------- 日志 ---------- */
    const logEl = q('.cvp-debug-log-entries');
    const logCopyBtn = q('.cvp-debug-log-copy');
    const debugLog = q('.cvp-debug-log');
    const debugOption = q('.cvp-more-debug-option');
    let debugOn = debug;          // 是否显示调试面板
    const logBuffer = [];         // 始终收集，开启时回填
    function formatLog(msg) {
        const t = new Date().toLocaleTimeString('en-US', { hour12: false });
        return `[${t}] ${msg}`;
    }
    function log(msg) {
        logBuffer.push(formatLog(msg));
        if (logBuffer.length > 200) logBuffer.splice(0, 100);
        if (!debugOn || !logEl) return;
        const line = document.createElement('div');
        line.className = 'cvp-debug-log-line';
        line.textContent = logBuffer[logBuffer.length - 1];
        logEl.append(line);
        while (logEl.children.length > 50) logEl.firstChild.remove();
        logEl.scrollTop = logEl.scrollHeight;
    }
    function flushDebugLog() {
        if (!logEl) return;
        logEl.innerHTML = '';
        for (const line of logBuffer.slice(-50)) {
            const d = document.createElement('div');
            d.className = 'cvp-debug-log-line';
            d.textContent = line;
            logEl.append(d);
        }
        logEl.scrollTop = logEl.scrollHeight;
    }
    function setDebugOn(on) {
        debugOn = on;
        if (debugLog) {
            debugLog.classList.toggle('cvp-debug-hidden', !on);
            if (on) {
                debugLog.classList.remove('collapsed');
                const c = q('.cvp-debug-log-collapse');
                if (c) c.textContent = '−';
                flushDebugLog();
            }
        }
        if (debugOption) debugOption.classList.toggle('cvp-more-active', on);
    }
    setDebugOn(debug);
    if (logCopyBtn) {
        logCopyBtn.addEventListener('click', e => {
            e.stopPropagation();
            navigator.clipboard?.writeText(logBuffer.join('\n'))
                .then(() => { logCopyBtn.textContent = '已复制'; setTimeout(() => logCopyBtn.textContent = '复制', 1500); })
                .catch(() => { logCopyBtn.textContent = '失败'; setTimeout(() => logCopyBtn.textContent = '复制', 1500); });
        });
    }
    if (debugOption) {
        debugOption.addEventListener('click', e => {
            e.stopPropagation();
            setDebugOn(!debugOn);
            const mm = q('.cvp-more-menu');
            if (mm) mm.classList.remove('cvp-more-show');
        });
    }
    if (debugLog) {
        const collapseBtn = q('.cvp-debug-log-collapse');
        collapseBtn?.addEventListener('click', e => {
            e.stopPropagation();
            const now = debugLog.classList.toggle('collapsed');
            collapseBtn.textContent = now ? '+' : '−';
        });
    }

    /* ---------- 计时与看门狗 ---------- */
    let loadStart = 0;
    let retryCount = 0;
    let usedFallback = false;
    const LOAD_TIMEOUT_MS = 25000;
    const NO_DATA_TIMEOUT_MS = 20000;
    let loadTimer = null;
    let noDataTimer = null;
    let lastDataAt = Date.now();
    let failureNotified = false;
    let mediaReady = false;

    const mainEndpoint = url.replace(/\?.*$/, '').replace(/\/+$/, '');
    const fallbackEndpoint = fallbackUrl ? fallbackUrl.replace(/\?.*$/, '').replace(/\/+$/, '') : '';
    const hasDifferentFallback = fallbackUrl && mainEndpoint !== fallbackEndpoint;
    log(`创建 src=${url.split('/').pop().split('?')[0]} 画中画=${state.pipSupported ? '支持' : '不支持'}`);
    log(hasDifferentFallback ? '[回退] 已配置备用端点' : '[回退] 无独立备用端点');

    function currentSourceUrl() { return usedFallback && fallbackUrl ? fallbackUrl : url; }
    function currentSourceLabel() { return usedFallback ? '备用端点' : '主端点'; }

    let videoLoadStarted = false;
    function startVideoLoad(reason) {
        if (videoLoadStarted) return;
        videoLoadStarted = true;
        loadStart = Date.now();
        video.src = url;
        video.load();
        armLoadTimer();
        log(`[阶段] ${reason} 开始加载`);
    }

    if (options.poster) {
        const img = new Image();
        let settled = false;
        const go = reason => { if (!settled) { settled = true; startVideoLoad(reason); } };
        img.onload = () => go('海报就绪');
        img.onerror = () => go('海报失败');
        img.src = options.poster;
        state.posterImg = img;
        setTimeout(() => go('海报超时(3s)'), 3000);
    } else {
        startVideoLoad('无海报');
    }

    /* ---------- 续播 ---------- */
    function loadResume() {
        if (!mediaId) return 0;
        return getPosition(mediaId) || 0;
    }
    function saveResume(t) {
        if (!mediaId || !state.durationReady || !video.duration) return;
        if (!isFinite(t) || t < 5 || video.duration - t < 5) return;
        setPosition(mediaId, Math.round(t * 10) / 10);
        pushProgress(mediaId, t, video.duration);
    }
    function clearResume() {
        if (!mediaId) return;
        clearPosition(mediaId);
        pushProgress(mediaId, 0, video.duration || 0);
    }

    function describeVideoError(err) {
        const code = err && err.code;
        if (code === 1) return '加载已中止';
        if (code === 2) return '网络错误（远端可能不可用）';
        if (code === 3) return '文件已损坏（解码失败）';
        if (code === 4) return '文件不可用或格式不支持';
        return '加载失败';
    }

    function showError(detailText, labelOverride) {
        if (!loadingOverlay) return;
        loadingOverlay.classList.add('cvp-loading-error');
        loadingOverlay.classList.remove('cvp-loading-show', 'cvp-loading-soft');
        wrapper.classList.add('cvp-error');
        let label = labelOverride || '加载失败';
        if (!labelOverride) {
            if (/NETWORK|网络/.test(detailText || '')) label = '加载失败（远端可能不可用）';
            else if (/DECODE/.test(detailText || '')) label = '加载失败（文件可能损坏）';
            else if (/超时/.test(detailText || '')) label = '加载超时';
            else if (/停滞/.test(detailText || '')) label = '播放停滞';
        }
        if (loadingText) loadingText.textContent = label;
        if (loadingDetail) loadingDetail.textContent = detailText || '';
        if (loadingBarFill) loadingBarFill.style.width = '0%';
        if (retryBtn) retryBtn.style.display = 'block';
    }

    function signalMediaReady(ready) {
        if (ready === mediaReady) return;
        mediaReady = ready;
        if (typeof options.onReadyChange === 'function') options.onReadyChange(ready);
    }

    /** 统一的「放弃」出口：报错 → 通知调用方（刷流据此跳过坏条目）。幂等。 */
    function notifyPlaybackFailure(reason) {
        showError(reason);
        signalMediaReady(false);
        if (failureNotified) return;
        failureNotified = true;
        if (typeof options.onError === 'function') options.onError(reason);
    }

    function armLoadTimer() {
        clearTimeout(loadTimer);
        loadTimer = setTimeout(() => {
            if (frameRendered || !video.src) return;
            log(`[警告] 加载超过 ${LOAD_TIMEOUT_MS / 1000}s 未出帧`);
            notifyPlaybackFailure(`加载超时（${LOAD_TIMEOUT_MS / 1000}s 无响应），可点击重试`);
        }, LOAD_TIMEOUT_MS);
    }
    function noteDataFlowing() {
        lastDataAt = Date.now();
        clearTimeout(noDataTimer);
        noDataTimer = null;
    }
    function armNoDataWatchdog() {
        if (noDataTimer) return;
        noDataTimer = setTimeout(() => {
            noDataTimer = null;
            if (video.paused || video.ended || !video.src) return;
            if (Date.now() - lastDataAt < NO_DATA_TIMEOUT_MS) { armNoDataWatchdog(); return; }
            log('[警告] 播放停滞');
            notifyPlaybackFailure(`播放停滞（${NO_DATA_TIMEOUT_MS / 1000}s 无数据进展），可点击重试`);
        }, NO_DATA_TIMEOUT_MS);
    }
    function clearLoadTimers() {
        clearTimeout(loadTimer);
        clearTimeout(noDataTimer);
        noDataTimer = null;
    }

    function retryVideo() {
        retryCount += 1;
        if (retryBtn) retryBtn.style.display = 'none';
        loadingOverlay?.classList.remove('cvp-loading-error', 'cvp-loading-soft');
        wrapper.classList.remove('cvp-error');
        bufferStartTime = 0; bufferStartBytes = 0; lastBufferLog = 0;
        state.durationReady = false;
        frameRendered = false;
        failureNotified = false;
        signalMediaReady(false);
        loadStart = Date.now();
        const src = currentSourceUrl();
        video.src = src + (src.includes('?') ? '&' : '?') + 'retry=' + Date.now();
        video.load();
        armLoadTimer();
        showLoading('重试中...');
        log(`[重试] 第${retryCount}次 (${currentSourceLabel()})`);
    }
    retryBtn?.addEventListener('click', e => { e.stopPropagation(); retryVideo(); });

    function updatePlayState() {
        state.playing = !video.paused;
        iconPlay.style.display = state.playing ? 'none' : 'block';
        iconPause.style.display = state.playing ? 'block' : 'none';
        if ('mediaSession' in navigator) {
            try { navigator.mediaSession.playbackState = state.playing ? 'playing' : 'paused'; } catch {}
        }
    }

    /* ---------- 系统媒体控制 ---------- */
    if ('mediaSession' in navigator) {
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title,
                artist: options.sourceName || 'WebSua',
                album: 'WebSua 视频流',
                artwork: options.poster ? [{ src: options.poster, sizes: '512x512' }] : [],
            });
            const act = (a, h) => { try { navigator.mediaSession.setActionHandler(a, h); } catch {} };
            act('play', () => safePlay('系统媒体键'));
            act('pause', () => video.pause());
            act('seekbackward', () => seekBy(-10));
            act('seekforward', () => seekBy(10));
            act('seekto', d => {
                if (d && d.seekTime != null && isFinite(d.seekTime)) {
                    seekTargetTime = d.seekTime;
                    video.currentTime = d.seekTime;
                    seekWithSafety();
                }
            });
            log('[阶段] 已注册系统媒体控制');
        } catch (e) {
            log(`[警告] Media Session 初始化失败: ${e.message}`);
        }
    }

    function updateProgress() {
        if (isDragging || isSeeking || !video.duration) return;
        const pct = (video.currentTime / video.duration) * 100;
        progressPlayed.style.width = pct + '%';
        progressThumb.style.left = pct + '%';
        timeEl.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
        if (video.buffered.length > 0) {
            progressBuffered.style.width = (video.buffered.end(video.buffered.length - 1) / video.duration) * 100 + '%';
        }
    }

    function showControls() {
        state.controlsVisible = true;
        controls.style.opacity = '1';
        controls.style.pointerEvents = 'auto';
        clearTimeout(state.controlsTimer);
        if (state.playing) state.controlsTimer = setTimeout(hideControls, 3000);
    }
    function hideControls() {
        if (video.paused || speedMenu.classList.contains('cvp-speed-show')
            || rotateMenu.classList.contains('cvp-rotate-show')
            || moreMenu.classList.contains('cvp-more-show')
            || infoPanel.classList.contains('cvp-info-show')) return;
        state.controlsVisible = false;
        controls.style.opacity = '0';
        controls.style.pointerEvents = 'none';
    }

    function safePlay(why) {
        video.play().catch(err => log(`[错误] 播放被拒绝(${why}) ${err.name}`));
    }
    function togglePlay() {
        if (video.paused || video.ended) {
            if (video.ended || replayShown) { video.currentTime = 0; hideReplay(); }
            if (!videoLoadStarted) startVideoLoad('用户点击');
            safePlay('点击播放');
        } else {
            video.pause();
        }
    }

    let replayShown = false;
    function showReplay() { replayShown = true; playBtn.style.display = 'none'; replayBtn.style.display = 'flex'; }
    function hideReplay() { replayShown = false; playBtn.style.display = ''; replayBtn.style.display = 'none'; }
    replayBtn.addEventListener('click', e => {
        e.stopPropagation();
        video.currentTime = 0;
        hideReplay();
        safePlay('重播');
        showControls();
    });

    function seekBy(delta) {
        if (!state.durationReady || !video.duration || !isFinite(video.duration)) return;
        const target = Math.max(0, Math.min(video.duration, video.currentTime + delta));
        seekTargetTime = target;
        video.currentTime = target;
        seekWithSafety();
        showControls();
    }

    function showTapIndicator(side) {
        const e = side === 'left' ? tapLeft : tapRight;
        e.classList.add('cvp-tap-show');
        setTimeout(() => e.classList.remove('cvp-tap-show'), 400);
    }

    /* ---------- 事件绑定：播放控制 ---------- */
    playBtn.addEventListener('click', togglePlay);
    video.addEventListener('click', togglePlay);
    video.addEventListener('play', () => { hideReplay(); updatePlayState(); showControls(); });
    video.addEventListener('pause', () => { saveResume(video.currentTime); updatePlayState(); showControls(); });
    video.addEventListener('ended', () => {
        log('[事件] 播放结束');
        clearResume();
        clearLoadTimers();
        hideLoading();
        updatePlayState();
        // 有 onEnded 时由调用方决定是否继续（刷流模式自动下一条）
        if (typeof options.onEnded === 'function') {
            options.onEnded();
            return;
        }
        showReplay();
        showControls();
    });

    let seekLogTime = 0;
    let lastResumeSave = 0;
    video.addEventListener('timeupdate', () => {
        noteDataFlowing();
        updateProgress();
        if (Date.now() - lastResumeSave > 5000 && !video.paused) {
            saveResume(video.currentTime);
            lastResumeSave = Date.now();
        }
        if (Date.now() - seekLogTime < 2000) log(`[事件] t=${formatTime(video.currentTime)}`);
    });
    video.addEventListener('loadstart', () => log('[阶段] 源开始加载'));
    video.addEventListener('loadedmetadata', () => {
        state.durationReady = true;
        const ms = loadStart ? Date.now() - loadStart : 0;
        log(`[阶段] 元数据就绪 时长=${formatTime(video.duration)} ${video.videoWidth}×${video.videoHeight} 耗时=${ms}ms`);
        if (options.onDuration && video.duration) options.onDuration(video.duration);
        const resume = loadResume();
        if (resume > 5 && video.duration - resume > 10) {
            log(`[续播] 恢复到 ${formatTime(resume)}`);
            seekTargetTime = resume;
            video.currentTime = resume;
            seekWithSafety();
        }
        updateProgress();
        if (state.rotation) computeRotateTransform();
    });
    video.addEventListener('progress', () => {
        noteDataFlowing();
        updateProgress();
        if (loadingOverlay?.classList.contains('cvp-loading-show')) {
            updateLoadingDetail();
            const bufEnd = getBufferedEnd();
            if (Date.now() - lastBufferLog > 1000 && bufferStartTime && bufEnd > bufferStartBytes) {
                const elapsed = (Date.now() - bufferStartTime) / 1000;
                const speed = (bufEnd - bufferStartBytes) / elapsed;
                log(`[缓冲] ${((bufEnd / video.duration) * 100).toFixed(1)}% 速率=${speed > 1 ? speed.toFixed(1) + 'x' : (speed * 60).toFixed(0) + '秒/秒'}`);
                lastBufferLog = Date.now();
            }
        }
    });

    let seekTimeout = null;
    let seekTargetTime = 0;
    let isDragging = false;
    let isSeeking = false;

    function resetSeeking() { isSeeking = false; clearTimeout(seekTimeout); updateProgress(); }
    video.addEventListener('seeking', () => { isSeeking = true; clearTimeout(seekTimeout); seekLogTime = Date.now(); });
    video.addEventListener('seeked', () => { log('[事件] 跳转完成'); resetSeeking(); });
    function seekWithSafety() {
        isSeeking = true;
        clearTimeout(seekTimeout);
        seekTimeout = setTimeout(() => { isSeeking = false; updateProgress(); }, 500);
    }

    let bufferStartTime = 0;
    let bufferStartBytes = 0;
    let lastBufferLog = 0;
    function getBufferedEnd() {
        if (!video.buffered.length || !video.duration) return 0;
        return video.buffered.end(video.buffered.length - 1);
    }
    function updateLoadingDetail() {
        if (!video.duration) return;
        const bufEnd = getBufferedEnd();
        const pct = (bufEnd / video.duration) * 100;
        loadingBarFill.style.width = pct + '%';
        let speedText = '';
        if (bufferStartTime && bufEnd > bufferStartBytes) {
            const elapsed = (Date.now() - bufferStartTime) / 1000;
            if (elapsed > 0) {
                const speed = (bufEnd - bufferStartBytes) / elapsed;
                speedText = speed > 1 ? ` | ${speed.toFixed(1)}x` : ` | ${(speed * 60).toFixed(0)}秒/秒`;
            }
        }
        loadingDetail.textContent = `缓冲 ${pct.toFixed(1)}%${speedText} (${formatTime(bufEnd)} / ${formatTime(video.duration)})`;
    }

    function showLoading(text, soft) {
        if (!loadingOverlay) return;
        wrapper.classList.remove('cvp-error');
        loadingOverlay.classList.add('cvp-loading-show');
        loadingOverlay.classList.toggle('cvp-loading-soft', !!soft);
        if (loadingText) loadingText.textContent = text || '加载中...';
        bufferStartTime = Date.now();
        bufferStartBytes = getBufferedEnd();
        updateLoadingDetail();
    }
    function hideLoading() { loadingOverlay?.classList.remove('cvp-loading-show'); }

    video.addEventListener('waiting', () => {
        showLoading('缓冲中...', frameRendered);
        armStallWatchdog();
        armNoDataWatchdog();
    });
    const onReady = () => {
        hideLoading(); clearLoadTimers(); failureNotified = false;
        signalMediaReady(true);
        frameRendered = true; stalledCount = 0; clearTimeout(stallTimer); stallReloadCount = 0;
        noteDataFlowing();
        log(`[事件] 可播放 耗时=${loadStart ? Date.now() - loadStart : 0}ms${usedFallback ? '(备用端点)' : ''}`);
    };
    video.addEventListener('canplay', onReady);
    video.addEventListener('playing', () => { onReady(); if (typeof options.onPlay === 'function') options.onPlay(); });

    video.addEventListener('error', () => {
        const err = video.error;
        let detail = `code=${err?.code}`;
        if (err?.code === 1) detail += ' MEDIA_ERR_ABORTED(加载中止)';
        else if (err?.code === 2) detail += ' MEDIA_ERR_NETWORK(网络错误)';
        else if (err?.code === 3) detail += ' MEDIA_ERR_DECODE(解码错误)';
        else if (err?.code === 4) detail += ' MEDIA_ERR_SRC_NOT_SUPPORTED(格式不支持)';
        detail += ` msg=${err?.message}`;
        log(`[错误] ${detail}`);
        clearLoadTimers();
        signalMediaReady(false);

        // 主端点失败 → 切备用端点
        if (fallbackUrl && !usedFallback) {
            usedFallback = true;
            log('[回退] 主端点失败 → 1s 后切换备用端点');
            setTimeout(() => {
                if (video.error) {
                    video.src = fallbackUrl + (fallbackUrl.includes('?') ? '&' : '?') + 'retry=' + Date.now();
                    video.load();
                    safePlay('端点回退');
                }
            }, 1000);
            return;
        }

        const retriable = err && (err.code === 2 ||
            (err.code === 4 && (err.message || '').includes('DEMUXER')));
        if (retriable && retryCount < 1) {
            log('[自动重试] 1.5s 后重试');
            setTimeout(() => { if (video.error) retryVideo(); }, 1500);
            return;
        }

        showError(detail.replace(' msg=', ' · '), describeVideoError(err));
        // 补探一次，拿服务端返回的中文原因
        probeMediaFailure(currentSourceUrl()).then(reason => {
            if (!reason || !wrapper.classList.contains('cvp-error')) return;
            log(`[诊断] 服务端：${reason}`);
            showError(reason, '文件不可用');
        });
        if (!failureNotified) {
            failureNotified = true;
            if (typeof options.onError === 'function') options.onError(detail);
        }
    });
    video.addEventListener('canplaythrough', () => {
        log(`[阶段] 可连续播放 已缓冲=${formatTime(getBufferedEnd())}/${formatTime(video.duration)}`);
    });

    let stalledCount = 0;
    let frameRendered = false;
    let stallReloadCount = 0;
    let stallTimer = null;
    function armStallWatchdog() {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
            if (frameRendered || !video.src) return;
            if (stallReloadCount >= 3) {
                log('[警告] 重试 3 次仍未出帧，放弃');
                notifyPlaybackFailure('缓冲停滞：已自动重试 3 次仍未出帧，可点击重试');
                return;
            }
            stallReloadCount++;
            const src = currentSourceUrl();
            log(`[重试] ${stallReloadCount}/3 缓冲停滞未出帧，重置源 (${currentSourceLabel()})`);
            video.pause();
            video.removeAttribute('src');
            video.load();
            video.src = src + (src.includes('?') ? '&' : '?') + 'stallretry=' + Date.now();
            video.load();
        }, 12000);
    }
    video.addEventListener('stalled', () => {
        stalledCount++;
        log(`[警告] 网络停滞 (第${stalledCount}次)`);
        armNoDataWatchdog();
        armStallWatchdog();
    });
    video.addEventListener('durationchange', () => log(`[事件] 时长 ${formatTime(video.duration)}`));
    video.addEventListener('ratechange', () => log(`[事件] 速率 ${video.playbackRate}x`));
    video.addEventListener('volumechange', () => {
        log(`[事件] 音量 ${video.muted ? '静音' : Math.round(video.volume * 100) + '%'}`);
        localStorage.setItem('cvpVolume', video.volume);
        localStorage.setItem('cvpMuted', video.muted);
    });
    video.addEventListener('loadeddata', () => {
        log(`[阶段] 数据就绪 耗时=${loadStart ? Date.now() - loadStart : 0}ms，自动播放`);
        safePlay('autoplay');
    });

    /* ---------- 双击快进 ---------- */
    let lastTapTime = 0, lastTapX = 0;
    wrapper.addEventListener('click', e => {
        if (e.target.closest('.cvp-controls, .cvp-speed-menu')) return;
        const now = Date.now();
        const rect = wrapper.getBoundingClientRect();
        const x = e.clientX - rect.left;
        if (now - lastTapTime < 300 && Math.abs(x - lastTapX) < 50) {
            if (lastTapX < rect.width / 2) { seekBy(-10); showTapIndicator('left'); }
            else { seekBy(10); showTapIndicator('right'); }
            lastTapTime = 0;
        } else {
            lastTapTime = now;
            lastTapX = x;
        }
    });

    /* ---------- 进度条拖动 ---------- */
    function updateTooltip(pct) {
        if (!tooltip || !video.duration) return;
        tooltip.textContent = formatTime(pct * video.duration);
        tooltip.style.left = (pct * 100) + '%';
        tooltip.style.opacity = '1';
    }
    function seekTo(e) {
        if (!state.durationReady || !video.duration || !isFinite(video.duration)) return;
        const rect = progress.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const target = pct * video.duration;
        seekTargetTime = target;
        video.currentTime = target;
        progressPlayed.style.width = (pct * 100) + '%';
        progressThumb.style.left = (pct * 100) + '%';
        timeEl.textContent = `${formatTime(pct * video.duration)} / ${formatTime(video.duration)}`;
        updateTooltip(pct);
        seekWithSafety();
    }
    progress.addEventListener('mousemove', e => {
        if (!video.duration || !isFinite(video.duration)) return;
        const rect = progress.getBoundingClientRect();
        updateTooltip(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
    });
    progress.addEventListener('mouseleave', () => { if (tooltip) tooltip.style.opacity = '0'; });
    progress.addEventListener('mousedown', e => {
        e.preventDefault(); e.stopPropagation();
        isDragging = true; isSeeking = true;
        seekTo(e);
        showControls();
    });
    const onDocMouseMove = e => { if (isDragging) seekTo(e); };
    const onDocMouseUp = () => { if (isDragging) isDragging = false; };
    document.addEventListener('mousemove', onDocMouseMove);
    document.addEventListener('mouseup', onDocMouseUp);
    progress.addEventListener('touchstart', e => {
        e.stopPropagation();
        if (!state.durationReady || !video.duration || !isFinite(video.duration)) return;
        isDragging = true; isSeeking = true;
        seekTo(e.touches[0]);
        showControls();
    }, { passive: false });
    progress.addEventListener('touchmove', e => {
        if (isDragging) { e.preventDefault(); seekTo(e.touches[0]); }
    }, { passive: false });
    progress.addEventListener('touchend', () => { isDragging = false; });

    /* ---------- 速度 ---------- */
    speedBtn.addEventListener('click', e => { e.stopPropagation(); speedMenu.classList.toggle('cvp-speed-show'); });
    function applySpeed(spd) {
        video.playbackRate = spd;
        state.speed = spd;
        speedBtn.textContent = spd === 1 ? '1x' : spd + 'x';
        speedMenu.querySelectorAll('.cvp-speed-option').forEach(o =>
            o.classList.toggle('cvp-speed-active', parseFloat(o.dataset.speed) === spd));
        localStorage.setItem('cvpPlaybackSpeed', spd);
        showControls();
    }
    speedMenu.querySelectorAll('.cvp-speed-option').forEach(opt => {
        opt.addEventListener('click', e => {
            e.stopPropagation();
            applySpeed(parseFloat(opt.dataset.speed));
            speedMenu.classList.remove('cvp-speed-show');
        });
    });
    const closeSpeedMenu = e => {
        if (!wrapper.contains(e.target)) {
            speedMenu.classList.remove('cvp-speed-show');
            if (state.playing) hideControls();
        }
    };
    document.addEventListener('click', closeSpeedMenu);

    /* ---------- 静音 / 音量 ---------- */
    function updateVolumeUI() {
        const vol = state.muted ? 0 : state.volume;
        if (volumeFill) volumeFill.style.width = (vol * 100) + '%';
        iconVol.style.display = state.muted ? 'none' : 'block';
        iconMuted.style.display = state.muted ? 'block' : 'none';
    }
    muteBtn.addEventListener('click', e => {
        e.stopPropagation();
        state.muted = !state.muted;
        video.muted = state.muted;
        updateVolumeUI();
        muteBtn.dataset.tooltip = state.muted ? '取消静音' : '静音';
        muteBtn.setAttribute('aria-label', state.muted ? '取消静音' : '静音');
        showControls();
    });
    function setVolumeFromEvent(e) {
        if (!volumeSlider) return;
        const rect = volumeSlider.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        state.volume = pct;
        video.volume = pct;
        if (pct > 0) { state.muted = false; video.muted = false; }
        updateVolumeUI();
        showControls();
    }
    volumeSlider?.addEventListener('mousedown', e => {
        e.preventDefault(); e.stopPropagation();
        setVolumeFromEvent(e);
        const onMove = ev => setVolumeFromEvent(ev);
        const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
    volumeSlider?.addEventListener('touchstart', e => { e.stopPropagation(); setVolumeFromEvent(e.touches[0]); }, { passive: true });
    volumeSlider?.addEventListener('touchmove', e => { e.preventDefault(); setVolumeFromEvent(e.touches[0]); }, { passive: false });

    /* ---------- 循环 ---------- */
    function updateLoopUI() { moreLoopOption.classList.toggle('cvp-more-active', state.loop); }
    function toggleLoop() {
        state.loop = !state.loop;
        video.loop = state.loop;
        updateLoopUI();
        showControls();
    }
    moreLoopOption.addEventListener('click', e => {
        e.stopPropagation();
        toggleLoop();
        moreMenu.classList.remove('cvp-more-show');
    });

    /* ---------- 截图 ---------- */
    moreShotOption.addEventListener('click', e => {
        e.stopPropagation();
        moreMenu.classList.remove('cvp-more-show');
        if (!video.videoWidth || video.readyState < 2) { showToast('视频尚未就绪，无法截图', 'err'); return; }
        try {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(blob => {
                if (!blob) { showToast('截图生成失败', 'err'); return; }
                const objUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = objUrl;
                a.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}_${Math.floor(video.currentTime)}s.png`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(objUrl), 1000);
                showToast('已保存截图', 'ok');
            }, 'image/png');
        } catch (err) {
            showToast('截图失败：' + err.message, 'err');
        }
    });

    /* ---------- 下载 / 复制直链 ---------- */
    moreDownloadOption.addEventListener('click', e => {
        e.stopPropagation();
        moreMenu.classList.remove('cvp-more-show');
        const a = document.createElement('a');
        a.href = `${currentSourceUrl()}${currentSourceUrl().includes('?') ? '&' : '?'}dl=1`;
        a.download = title;
        document.body.append(a);
        a.click();
        a.remove();
    });
    moreLinkOption.addEventListener('click', e => {
        e.stopPropagation();
        moreMenu.classList.remove('cvp-more-show');
        const full = new URL(currentSourceUrl(), location.origin).href;
        const done = () => showToast('直链已复制，可用 VLC 打开', 'ok');
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(full).then(done).catch(fallbackCopy);
        } else fallbackCopy();
        function fallbackCopy() {
            const ta = document.createElement('textarea');
            ta.value = full;
            ta.style.cssText = 'position:fixed;opacity:0';
            document.body.append(ta);
            ta.select();
            try { document.execCommand('copy'); done(); } catch { showToast('复制失败', 'err'); }
            ta.remove();
        }
    });

    /* ---------- 视频信息 ---------- */
    let infoFetched = false;
    function toggleInfoPanel() {
        const willShow = !infoPanel.classList.contains('cvp-info-show');
        infoPanel.classList.toggle('cvp-info-show');
        if (willShow && !infoFetched) {
            infoFetched = true;
            infoBody.innerHTML = '<div class="cvp-info-loading">加载中...</div>';
            if (!mediaId) {
                infoBody.innerHTML = '<div class="cvp-info-error">无媒体 ID</div>';
                return;
            }
            fetch(`/api/media/${mediaId}`)
                .then(r => r.json())
                .then(data => {
                    if (data.error) {
                        infoBody.innerHTML = `<div class="cvp-info-error">${escapeHtml(data.error)}</div>`;
                        return;
                    }
                    const rows = [];
                    if (data.file_name) rows.push(['文件名', data.file_name]);
                    if (data.source_name) rows.push(['来源', data.source_name]);
                    if (data.file_size_str) rows.push(['大小', data.file_size_str]);
                    if (data.width && data.height) rows.push(['分辨率', `${data.width}×${data.height}`]);
                    if (data.codec) rows.push(['编码', data.codec]);
                    if (data.duration) rows.push(['时长', formatTime(data.duration)]);
                    if (data.mime) rows.push(['类型', data.mime]);
                    if (data.folder && data.folder !== '/') rows.push(['目录', data.folder]);
                    infoBody.innerHTML = rows.map(([k, v]) =>
                        `<div class="cvp-info-row"><span>${k}</span><span>${escapeHtml(String(v))}</span></div>`
                    ).join('') || '<div class="cvp-info-error">无可用信息</div>';
                })
                .catch(err => { infoBody.innerHTML = `<div class="cvp-info-error">获取失败：${escapeHtml(err.message)}</div>`; });
        }
        showControls();
    }
    moreInfoOption.addEventListener('click', e => {
        e.stopPropagation();
        moreMenu.classList.remove('cvp-more-show');
        toggleInfoPanel();
    });
    const closeInfoPanel = e => {
        if (!wrapper.contains(e.target)) {
            infoPanel.classList.remove('cvp-info-show');
            rotateMenu.classList.remove('cvp-rotate-show');
            moreMenu.classList.remove('cvp-more-show');
            if (state.playing) hideControls();
        }
    };
    document.addEventListener('click', closeInfoPanel);

    /* ---------- 页面可见性 / 网络恢复 ---------- */
    const onVisibilityChange = () => {
        if (document.hidden && !video.paused) video.pause();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const onOnline = () => {
        log('[事件] 网络恢复');
        if (loadingOverlay?.classList.contains('cvp-loading-error')) retryVideo();
    };
    window.addEventListener('online', onOnline);

    /* ---------- 全屏 ---------- */
    fullscreenBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (document.fullscreenElement) document.exitFullscreen();
        else wrapper.requestFullscreen?.();
        showControls();
    });
    const onFullscreenChange = () => {
        state.fullscreen = !!document.fullscreenElement;
        fullscreenBtn.dataset.tooltip = state.fullscreen ? '退出全屏' : '全屏';
        if (typeof options.onFullscreenChange === 'function') options.onFullscreenChange(state.fullscreen);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);

    /* ---------- 画中画 ---------- */
    if (state.pipSupported) {
        pipBtn.addEventListener('click', async e => {
            e.stopPropagation();
            try {
                if (document.pictureInPictureElement) await document.exitPictureInPicture();
                else await video.requestPictureInPicture();
            } catch (err) {
                showToast('画中画不可用', 'err');
            }
            showControls();
        });
    } else {
        pipBtn.style.display = 'none';
    }

    /* ---------- 旋转 ---------- */
    const ROTATE_CLASSES = ['', 'cvp-rotate-90', 'cvp-rotate-180', 'cvp-rotate-270'];
    function computeRotateTransform() {
        if (!state.rotation) return;
        const rect = wrapper.getBoundingClientRect();
        const a = (video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : 0;
        if (!a || !rect.width || !rect.height) return;
        if (state.rotation === 180) { video.style.transform = 'rotate(180deg)'; return; }
        const cw = Math.min(rect.width, rect.height * a);
        const ch = Math.min(rect.height, rect.width / a);
        const s = Math.max(rect.width / ch, rect.height / cw);
        video.style.transform = `rotate(${state.rotation === 90 ? 90 : -90}deg) scale(${s})`;
    }
    function setRotation(deg) {
        state.rotation = ((deg % 360) + 360) % 360;
        wrapper.classList.remove(...ROTATE_CLASSES.slice(1));
        if (state.rotation) {
            wrapper.classList.add('cvp-rotate-' + state.rotation);
            computeRotateTransform();
        } else {
            video.style.transform = '';
        }
        log(`[操作] 旋转 ${state.rotation}°`);
        showControls();
    }
    rotateBtn.addEventListener('click', e => {
        e.stopPropagation();
        const show = rotateMenu.classList.toggle('cvp-rotate-show');
        rotateBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
        moreMenu.classList.remove('cvp-more-show');
    });
    rotateMenu.querySelectorAll('.cvp-rotate-option').forEach(opt => {
        opt.addEventListener('click', e => {
            e.stopPropagation();
            setRotation(state.rotation + parseInt(opt.dataset.deg, 10));
            rotateMenu.classList.remove('cvp-rotate-show');
            rotateBtn.setAttribute('aria-expanded', 'false');
        });
    });
    moreBtn.addEventListener('click', e => {
        e.stopPropagation();
        const show = moreMenu.classList.toggle('cvp-more-show');
        moreBtn.setAttribute('aria-expanded', show ? 'true' : 'false');
        rotateMenu.classList.remove('cvp-rotate-show');
        infoPanel.classList.remove('cvp-info-show');
        showControls();
    });
    const onRotateResize = () => { if (state.rotation) computeRotateTransform(); };
    window.addEventListener('resize', onRotateResize);

    seekBack.addEventListener('click', e => { e.stopPropagation(); seekBy(-10); });
    seekForward.addEventListener('click', e => { e.stopPropagation(); seekBy(10); });

    /* ---------- 键盘 ---------- */
    const keyHandler = e => {
        // 只有当前播放器才响应键盘（流式切换后旧播放器的监听器已被移除，这里再兜一层）
        if (activePlayer !== player) return;
        if (options.keyEnabled === false) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        switch (e.key) {
            case ' ': case 'k': e.preventDefault(); togglePlay(); showControls(); break;
            case 'ArrowLeft': case 'j': e.preventDefault(); seekBy(-10); break;
            case 'ArrowRight': case 'l': e.preventDefault(); seekBy(10); break;
            case 'ArrowUp':
                e.preventDefault();
                state.volume = Math.min(1, state.volume + 0.1);
                video.volume = state.volume; state.muted = false; video.muted = false;
                updateVolumeUI(); showControls();
                break;
            case 'ArrowDown':
                e.preventDefault();
                state.volume = Math.max(0, state.volume - 0.1);
                video.volume = state.volume;
                updateVolumeUI(); showControls();
                break;
            case '0': case '1': case '2': case '3': case '4':
            case '5': case '6': case '7': case '8': case '9':
                e.preventDefault();
                if (state.durationReady && video.duration && isFinite(video.duration)) {
                    seekTargetTime = (parseInt(e.key, 10) / 10) * video.duration;
                    video.currentTime = seekTargetTime;
                    seekWithSafety();
                    showControls();
                }
                break;
            case 'm': e.preventDefault(); muteBtn.click(); break;
            case 'f': e.preventDefault(); fullscreenBtn.click(); break;
            case 'L': e.preventDefault(); toggleLoop(); break;
            case 'r': e.preventDefault(); setRotation(state.rotation + 90); break;
            case 'R': e.preventDefault(); setRotation(state.rotation - 90); break;
        }
    };
    document.addEventListener('keydown', keyHandler);

    /* ---------- 恢复偏好 ---------- */
    const savedSpeed = parseFloat(localStorage.getItem('cvpPlaybackSpeed') || '1');
    if (isFinite(savedSpeed) && savedSpeed > 0 && savedSpeed !== 1) {
        video.playbackRate = savedSpeed;
        speedBtn.textContent = savedSpeed === 1 ? '1x' : savedSpeed + 'x';
        speedMenu.querySelectorAll('.cvp-speed-option').forEach(o =>
            o.classList.toggle('cvp-speed-active', parseFloat(o.dataset.speed) === savedSpeed));
    }
    const savedVolume = parseFloat(localStorage.getItem('cvpVolume') || '1');
    const savedMuted = localStorage.getItem('cvpMuted') === 'true';
    state.volume = isFinite(savedVolume) ? Math.max(0, Math.min(1, savedVolume)) : 1;
    state.muted = savedMuted;
    video.volume = state.volume;
    video.muted = state.muted;

    const player = {
        video, state, container,
        pause: () => { if (!video.paused) video.pause(); },
        resume: () => safePlay('resume'),
        get currentTime() { return video.currentTime; },
        set currentTime(t) { video.currentTime = t; },
        get duration() { return video.duration; },
        destroy: () => {
            document.removeEventListener('keydown', keyHandler);
            document.removeEventListener('mousemove', onDocMouseMove);
            document.removeEventListener('mouseup', onDocMouseUp);
            document.removeEventListener('fullscreenchange', onFullscreenChange);
            document.removeEventListener('click', closeSpeedMenu);
            document.removeEventListener('click', closeInfoPanel);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            window.removeEventListener('online', onOnline);
            window.removeEventListener('resize', onRotateResize);
            if ('mediaSession' in navigator) {
                try {
                    ['play', 'pause', 'seekbackward', 'seekforward', 'seekto']
                        .forEach(a => navigator.mediaSession.setActionHandler(a, null));
                    navigator.mediaSession.metadata = null;
                } catch {}
            }
            clearTimeout(state.controlsTimer);
            clearTimeout(seekTimeout);
            clearTimeout(stallTimer);
            clearLoadTimers();
            saveResume(video.currentTime);
            video.pause();
            video.removeAttribute('src');
            video.load();
            video.remove();
            if (state.posterImg) {
                state.posterImg.onload = state.posterImg.onerror = null;
                state.posterImg.src = '';
                state.posterImg = null;
            }
        },
    };
    activePlayer = player;

    showControls();
    updateVolumeUI();
    updateLoopUI();
    return player;
}

export function destroyActivePlayer() {
    if (activePlayer) {
        try { activePlayer.destroy(); } catch {}
        activePlayer = null;
    }
}

export function getActivePlayer() { return activePlayer; }
