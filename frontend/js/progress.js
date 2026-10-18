/**
 * 观看进度：内存为准，服务端持久化。
 *
 * 设计要点：
 *  - 播放器每 5 秒调用一次 pushProgress，这里做节流后再发请求，避免拖动进度条时刷屏
 *  - 页面关闭前 flush 一次，防止最后几秒丢失
 *  - 服务端是唯一事实来源，本地只缓存一份用于秒开续播
 */

import { api } from './utils.js';

const _pos = new Map();      // mediaId -> 秒
const _dur = new Map();      // mediaId -> 总时长
let _loaded = false;
let _flushTimer = null;
const _pending = new Map();  // 待同步的 mediaId

/** 启动时把全部进度拉进内存，续播才能同步生效。 */
export async function loadProgress() {
    if (_loaded) return;
    try {
        const data = await api('/api/progress');
        const map = data.progress || {};
        _pos.clear();
        for (const [id, p] of Object.entries(map)) {
            _pos.set(Number(id), p);
        }
        _loaded = true;
    } catch {
        // 拉取失败不阻塞播放，只是续播会失效
    }
}

export function getPosition(mediaId) {
    return _pos.get(Number(mediaId)) || 0;
}

export function setPosition(mediaId, seconds) {
    _pos.set(Number(mediaId), seconds);
}

/** 播放器定时上报（内部节流到最多 5 秒一次）。 */
export function pushProgress(mediaId, position, duration = 0) {
    if (!mediaId) return;
    if (duration) _dur.set(Number(mediaId), duration);
    _pos.set(Number(mediaId), position);
    _pending.set(Number(mediaId), position);
    if (_flushTimer) return;
    _flushTimer = setTimeout(flush, 5000);
}

/** 立即同步所有待上报进度。 */
export async function flush() {
    clearTimeout(_flushTimer);
    _flushTimer = null;
    if (!_pending.size) return;
    const batch = [..._pending.entries()];
    _pending.clear();
    await Promise.all(batch.map(([id, position]) =>
        api('/api/progress', {
            method: 'POST',
            body: { media_id: id, position, duration: _dur.get(id) || 0 },
        }).catch(() => {
            // 失败就把这条放回去，下次重试
            _pending.set(id, position);
        })
    ));
}

export function clearPosition(mediaId) {
    const id = Number(mediaId);
    _pos.delete(id);
    _pending.set(id, 0);
    if (!_flushTimer) _flushTimer = setTimeout(flush, 200);
}

export function getDuration(mediaId) {
    return _dur.get(Number(mediaId)) || 0;
}

// 关页面 / 切后台时兜底保存
window.addEventListener('pagehide', () => {
    const n = _pending.size;
    if (!n) return;
    // fetch 在卸载时可能被取消，退回 sendBeacon 保证送达
    const payload = JSON.stringify({
        entries: [..._pending.entries()].map(([id, position]) => ({
            media_id: id, position, duration: _dur.get(id) || 0,
        })),
    });
    if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/progress-batch', new Blob([payload], { type: 'application/json' }));
    } else {
        flush();
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden && _pending.size) flush();
});
