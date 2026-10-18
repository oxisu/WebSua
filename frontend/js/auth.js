/**
 * 访问门禁：局域网密码登录。
 *
 * 服务端开启门禁后，所有 /api/* 都需要令牌。这里负责：
 *   1. 启动时查 /api/auth/status，需要登录就弹全屏遮罩
 *   2. 任何请求撞上 401（令牌过期）时重新弹遮罩
 *
 * 令牌由服务端以 HttpOnly Cookie 下发，所以 <video>/<img> 的媒体请求
 * 也会自动带凭据 —— 前端不需要给媒体 URL 拼 token。
 */

import { api, el, setUnauthorizedHandler, showToast } from './utils.js';

let overlay = null;

/** 查询门禁状态。返回 { required, authed }。 */
export async function authStatus() {
    try {
        const d = await api('/api/auth/status');
        return { required: !!d.required, authed: !!d.authed };
    } catch (e) {
        // 查不到就当不需要门禁 —— 本机默认用法不能被一次网络抖动挡死
        return { required: false, authed: true };
    }
}

/**
 * 启动时调用：需要登录则渲染遮罩并阻断后续流程。
 * 返回 true 表示当前已通过（无需登录或登录成功）。
 */
export async function ensureAuth() {
    const st = await authStatus();
    if (!st.required || st.authed) return true;
    await new Promise(resolve => showLogin(resolve));
    return true;
}

function showLogin(onSuccess) {
    if (overlay) return;
    const input = el('input', {
        class: 'auth-input', type: 'password',
        placeholder: '请输入访问密码', autocomplete: 'current-password',
    });
    const errBox = el('div', { class: 'auth-err' });
    const btn = el('button', { class: 'btn btn-primary auth-submit' }, '登录');

    const submit = async () => {
        const pw = (input.value || '').trim();
        if (!pw) { errBox.textContent = '请输入密码'; return; }
        btn.disabled = true;
        btn.textContent = '登录中…';
        try {
            await api('/api/auth/login', { method: 'POST', body: { password: pw } });
            close();
            showToast('已登录', 'ok');
            if (onSuccess) onSuccess();
        } catch (e) {
            errBox.textContent = e.message || '登录失败';
            btn.disabled = false;
            btn.textContent = '登录';
            input.select();
        }
    };

    const close = () => {
        if (overlay) { overlay.remove(); overlay = null; }
    };

    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    btn.addEventListener('click', submit);

    overlay = el('div', { class: 'auth-overlay' },
        el('div', { class: 'auth-card' },
            el('div', { class: 'auth-title' }, '需要访问密码'),
            el('div', { class: 'auth-hint' },
                '本服务已开启局域网访问保护，请输入启动时设置的密码。'),
            input, errBox, btn));
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 50);
}

/** 令牌过期 / 被吊销：任何 401 都回到登录界面。 */
export function initAuthGuard() {
    setUnauthorizedHandler(() => {
        if (!overlay) showLogin(() => location.reload());
    });
}
