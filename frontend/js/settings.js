/**
 * 应用设置：前端偏好，存 localStorage，默认值如下。
 *
 *  - autoNext    自动连播（播放完自动下一条）        默认 关
 *  - debugLog    播放器调试日志                      默认 关
 *  - autoPlay    进入视频流自动播放                 默认 开
 *  - resumeLast  启动时恢复上次播放（源/顺序/当前条）  默认 开
 *  - pageFeed    视频流每页条数（也决定队列每页）      默认 24
 *  - pageLibrary 媒体库每页条数                      默认 48
 *
 * 注意：tgMode 已移除 —— TG 封面识别改为「每个数据源」独立开关（sources.tg_mode）。
 */

const KEY = 'websua.settings';

const DEFAULTS = {
    autoNext: false,
    debugLog: false,
    autoPlay: true,
    resumeLast: true,
    pageFeed: 24,
    pageLibrary: 48,
};

let _cache = null;

function load() {
    if (_cache) return _cache;
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
        _cache = { ...DEFAULTS, ...raw };
    } catch {
        _cache = { ...DEFAULTS };
    }
    return _cache;
}

export function getSetting(name) {
    return load()[name] ?? DEFAULTS[name];
}

export function setSetting(name, value) {
    load()[name] = value;
    localStorage.setItem(KEY, JSON.stringify(_cache));
    return value;
}

export function toggleSetting(name) {
    return setSetting(name, !getSetting(name));
}

export function allSettings() {
    return { ...load() };
}

export function resetSettings() {
    _cache = { ...DEFAULTS };
    localStorage.setItem(KEY, JSON.stringify(_cache));
}

// 订阅变更（设置弹窗与其他模块联动用）
const _listeners = new Set();
export function onSettingsChange(fn) {
    _listeners.add(fn);
    return () => _listeners.delete(fn);
}
export function emitSettingsChange() {
    for (const fn of _listeners) fn(allSettings());
}
