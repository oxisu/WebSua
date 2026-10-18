/**
 * 通用工具：DOM、格式化、请求封装、主题、Toast。
 */

/* ---------- DOM ---------- */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') {
            node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (k === 'html') node.innerHTML = v;
        else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
        if (c === null || c === undefined || c === false) continue;
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
}

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/* ---------- 格式化 ---------- */
export function formatSize(bytes) {
    const v = Number(bytes) || 0;
    if (v < 1024) return `${v} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let n = v / 1024;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export function formatTime(sec) {
    const s = Number(sec);
    if (!isFinite(s) || s < 0) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
        : `${m}:${String(ss).padStart(2, '0')}`;
}

export function formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    const now = Date.now() / 1000;
    const diff = now - ts;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
    return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/* ---------- 网络 ---------- */
export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

export async function api(path, options = {}) {
    const { method = 'GET', body, signal } = options;
    const init = { method, signal, headers: {} };
    if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
    }
    const res = await fetch(path, init);
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { /* 非 JSON */ }
    if (!res.ok || data.ok === false) {
        throw new ApiError(data.error || `请求失败 (${res.status})`, res.status);
    }
    return data;
}

/**
 * 探测媒体 URL 的真实失败原因。
 * <video> 只能报「格式不支持」，但服务端返回的是 JSON 错误体 ——
 * 补一次轻量请求拿到中文原因，用户才知道是「文件没了」还是「密码错了」。
 */
export async function probeMediaFailure(url) {
    try {
        const res = await fetch(url, { headers: { Range: 'bytes=0-1' } });
        const ctype = res.headers.get('content-type') || '';
        if (ctype.includes('application/json')) {
            const data = await res.json();
            return data.error || data.message || '服务端返回了错误';
        }
        if (res.status === 404) return '文件不存在（404）';
        if (res.status === 401 || res.status === 403) return '没有访问权限（' + res.status + '）';
        if (res.status === 502) return '远端服务器读取失败';
        if (!res.ok) return `服务端返回 ${res.status}`;
    } catch (e) {
        return `无法连接服务器：${e.message}`;
    }
    return null;
}

/* ---------- Toast ---------- */
let toastHost = null;
// 类型 → 图标 + 语义色（顶部弹出，颜色区分成功/错误/警告/提示）
const TOAST_TYPES = {
    ok:   { icon: '✓', label: '成功' },
    err:  { icon: '✕', label: '错误' },
    warn: { icon: '!', label: '警告' },
    info: { icon: 'i', label: '提示' },
};
export function showToast(message, type = 'info') {
    if (!toastHost) {
        toastHost = el('div', { class: 'toasts' });
        document.body.append(toastHost);
    }
    const t = TOAST_TYPES[type] || TOAST_TYPES.info;
    const node = el('div', {
        class: `toast toast-${type in TOAST_TYPES ? type : 'info'}`,
        role: 'status',
    },
        el('span', { class: 'toast-ico', 'aria-hidden': 'true' }, t.icon),
        el('span', { class: 'toast-msg' }, message));
    toastHost.append(node);
    // 顶部堆叠：同时最多保留 4 条，超出自动移除最旧的
    while (toastHost.children.length > 4) toastHost.firstChild.remove();
    const dur = type === 'err' ? 5000 : type === 'warn' ? 3800 : 2600;
    setTimeout(() => {
        node.classList.add('out');
        setTimeout(() => node.remove(), 300);
    }, dur);
    return node;
}

/* ---------- 主题 ---------- */
const THEME_KEY = 'websua.theme';      // 'auto' | 'light' | 'dark'
const _media = window.matchMedia('(prefers-color-scheme: light)');

export function resolveTheme(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    return _media.matches ? 'light' : 'dark';
}

export function applyTheme(mode) {
    const resolved = resolveTheme(mode);
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themeMode = mode;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
        meta.content = resolved === 'light' ? '#f4f6fa' : '#08090c';
    }
    return resolved;
}

export function initTheme() {
    let mode = localStorage.getItem(THEME_KEY) || 'auto';
    applyTheme(mode);

    // 跟随系统：系统主题变化时即时响应
    const onChange = () => {
        if ((localStorage.getItem(THEME_KEY) || 'auto') === 'auto') {
            const root = document.documentElement;
            root.classList.add('theme-transition');
            applyTheme('auto');
            setTimeout(() => root.classList.remove('theme-transition'), 300);
        }
    };
    if (_media.addEventListener) _media.addEventListener('change', onChange);
    else _media.addListener(onChange);

    return mode;
}

/** 循环：跟随系统 → 亮 → 暗 */
export function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    const cur = localStorage.getItem(THEME_KEY) || 'auto';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    localStorage.setItem(THEME_KEY, next);
    const root = document.documentElement;
    root.classList.add('theme-transition');
    applyTheme(next);
    setTimeout(() => root.classList.remove('theme-transition'), 300);
    return next;
}

export function getThemeMode() {
    return localStorage.getItem(THEME_KEY) || 'auto';
}

/* ---------- 杂项 ---------- */
export function debounce(fn, ms = 250) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

export function throttle(fn, ms = 100) {
    let last = 0, timer = null;
    return (...args) => {
        const now = Date.now();
        if (now - last >= ms) {
            last = now;
            fn(...args);
        } else if (!timer) {
            timer = setTimeout(() => {
                timer = null;
                last = Date.now();
                fn(...args);
            }, ms - (now - last));
        }
    };
}

export function bytesToHuman(bytes) { return formatSize(bytes); }

/** 让浏览器在空闲时执行，降低滚动卡顿 */
export function onIdle(fn) {
    if ('requestIdleCallback' in window) return requestIdleCallback(fn, { timeout: 500 });
    return setTimeout(fn, 1);
}

/**
 * SRT → WebVTT 转换（纯前端，零依赖）。
 *
 * 只做最小必要处理：补 WEBVTT 头、时间戳逗号改点、小时补足两位。
 * 不解析样式标签 —— .ass/.ssa 明确不支持，这里也不去模拟。
 */
export function srtToVtt(srt) {
    let text = (srt || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    text = text.replace(/(\d{1,2}):(\d{2}:\d{2}),(\d{3})/g,
        (_m, h, rest, ms) => String(h).padStart(2, '0') + ':' + rest + '.' + ms);
    return 'WEBVTT\n\n' + text.trim() + '\n';
}
