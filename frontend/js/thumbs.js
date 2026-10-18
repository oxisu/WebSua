/**
 * 视频缩略图：从远端视频截一帧当封面。
 *
 * 为什么不用 <img src="video.mp4#t=1">：
 *   浏览器不会为 <img> 解码视频流，只会显示破图/空白 —— 之前所有
 *   灰色占位块就是它导致的。唯一纯前端可行方案是挂一个真正的
 *   <video> 元素，seek 到目标秒后用 canvas 截帧。
 *
 * 设计要点：
 *  - 全局并发限制（同时最多 3 个 video 在解码），避免网格一页 48 个
 *    同时拉流把带宽和内存打爆
 *  - 结果按 mediaId 缓存在内存 Map；同一个会话里滚动来回不重复解码
 *  - 失败结果也缓存（undefined），坏文件不会反复重试
 *  - 请求的是 bytes=0- 的 Range 流，WebDAV + 本地代理都支持，代价可控
 */

const cache = new Map();      // mediaId -> dataURL | undefined(失败)
const pending = new Map();    // mediaId -> Promise<dataURL|null>
const inflight = new Set();
const waitQueue = [];

const MAX_CONCURRENT = 3;
const SEEK_TO = 1.0;          // 秒。太靠前可能是黑帧，1s 比较稳
const TIMEOUT_MS = 12000;

/**
 * 获取缩略图 dataURL。返回 null 表示失败（调用方回退到占位图）。
 * @param {number} mediaId
 * @param {string} streamUrl  /api/stream/{id}
 */
export function getThumbnail(mediaId, streamUrl) {
    const key = Number(mediaId);
    if (cache.has(key)) return Promise.resolve(cache.get(key) ?? null);
    if (pending.has(key)) return pending.get(key);

    const p = new Promise(resolve => {
        waitQueue.push({ key, streamUrl, resolve });
        pump();
    });
    pending.set(key, p);
    return p;
}

function pump() {
    while (inflight.size < MAX_CONCURRENT && waitQueue.length) {
        const job = waitQueue.shift();
        inflight.add(job.key);
        capture(job.key, job.streamUrl)
            .then(url => job.resolve(url))
            .finally(() => {
                inflight.delete(job.key);
                pump();
            });
    }
}

async function capture(key, streamUrl) {
    const url = await withTimeout(rawCapture(streamUrl), TIMEOUT_MS, key);
    cache.set(key, url ?? undefined);   // undefined 也算缓存过（失败不重试）
    pending.delete(key);
    return url;
}

function withTimeout(promise, ms, key) {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => {
            if (!cache.has(key)) cache.set(key, undefined);
            pending.delete(key);
            inflight.delete(key);
            resolve(null);
        }, ms)),
    ]).then(v => v ?? null);
}

async function rawCapture(streamUrl) {
    // 离屏 video：不进 DOM 也能解码，但 Safari 需要在 DOM 中 —— 稳妥起见挂上但隐藏
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.crossOrigin = 'anonymous';
    video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.append(video);

    try {
        const loaded = new Promise((resolve, reject) => {
            const ok = () => resolve();
            const bad = () => reject(new Error('metadata'));
            video.addEventListener('loadedmetadata', ok, { once: true });
            video.addEventListener('error', bad, { once: true });
            setTimeout(() => bad(), TIMEOUT_MS - 500);
        });
        video.src = streamUrl;
        await loaded;

        // 时长未知（某些流）就 seek 到 0.1s
        const t = isFinite(video.duration) && video.duration > SEEK_TO * 2 ? SEEK_TO : 0.1;
        await new Promise(resolve => {
            const done = () => resolve();
            video.addEventListener('seeked', done, { once: true });
            video.currentTime = t;
            setTimeout(done, 4000);   // seek 卡住也放行，用当前帧
        });

        if (!video.videoWidth || !video.videoHeight) return null;

        // 过小的画面没有截帧价值（音频/坏流）
        if (video.videoWidth < 32) return null;

        // 等一帧真正渲染出来
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const canvas = document.createElement('canvas');
        // 压到 320 宽足够网格和队列用，省内存
        const scale = Math.min(1, 320 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.72);
    } catch {
        return null;
    } finally {
        video.removeAttribute('src');
        try { video.load(); } catch {}
        video.remove();
    }
}

/** 图片类直接给 img 用（不算截帧，但也走同一入口便于统一占位逻辑）。 */
export function imagePlaceholder() { return null; }

/** 清空截帧缓存（切换 TG 封面模式等需要重跑时用）。 */
export function clearCache() {
    cache.clear();
    pending.clear();
}
