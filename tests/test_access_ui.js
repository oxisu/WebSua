/**
 * 浏览器端验收：局域网访问密码登录界面（v1.7.0）。
 *
 * 自包含：本测试自己拉起主服务（带 --password），结束后清理。
 * 运行（playwright-core 装在隔离工作区，需要 NODE_PATH）：
 *   NODE_PATH=<workspace>/node_modules node tests/test_access_ui.js
 *
 * 覆盖：
 *  1. 开启门禁后首次访问弹出全屏登录遮罩
 *  2. 错误密码：遮罩不消失并显示中文错误
 *  3. 正确密码：遮罩消失、应用正常进入（Cookie 生效，媒体请求自动带凭据）
 *  4. 无 JS 运行时错误
 */
const { chromium } = require('playwright-core');
const { chromiumPath } = require('./browser-env.js');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const EXEC = chromiumPath();
const ROOT = path.resolve(__dirname, '..');
const PY = process.env.WEBSUA_PYTHON || 'python';
const APP_PORT = 8977;
const BASE = `http://127.0.0.1:${APP_PORT}/`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'websua-accessui-'));
const PASSWORD = '局域网口令123';

const PASS = [], FAIL = [];
const check = (l, c, d = '') => (c ? PASS : FAIL).push(l + (d ? '  ' + d : ''));
const procs = [];

function start(args, envExtra) {
    const p = spawn(PY, args, { cwd: ROOT, env: { ...process.env, ...envExtra }, stdio: 'ignore' });
    procs.push(p);
    return p;
}

async function waitHealth(timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        try {
            const r = await fetch(BASE + 'api/health');
            if (r.ok) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 300));
    }
    return false;
}

async function main() {
    start(['main.py', '--port', String(APP_PORT), '--password', PASSWORD],
          { WEBSUA_DATA: DATA });
    if (!await waitHealth()) { check('服务启动', false); return finish(); }

    const b = await chromium.launch({
        executablePath: EXEC, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    const http401 = [];
    p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
    p.on('console', m => {
        // 浏览器把「非 2xx 的 fetch」也记成 console error，那不是 JS 异常；
        // 网络层面的失败单独用 http401 统计，避免和真正的运行时错误混在一起
        if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
            errs.push(m.text());
        }
    });
    p.on('response', r => { if (r.status() === 401) http401.push(new URL(r.url()).pathname); });

    await p.goto(BASE, { waitUntil: 'networkidle', timeout: 20000 });

    // ---- 1. 登录遮罩 ----
    const overlay = p.locator('.auth-overlay');
    let shown = true;
    try { await overlay.waitFor({ state: 'visible', timeout: 15000 }); }
    catch { shown = false; }
    check('开启门禁后弹出登录遮罩', shown);
    check('遮罩含密码输入框',
          await p.locator('.auth-overlay input[type="password"]').count() > 0);

    // ---- 2. 错误密码 ----
    await p.fill('.auth-overlay input[type="password"]', '肯定不对');
    await p.click('.auth-submit');
    await p.waitForTimeout(1200);
    const errText = (await p.locator('.auth-err').textContent() || '').trim();
    check('错误密码显示中文提示', errText.length > 0, errText);
    check('错误密码不关闭遮罩', await overlay.count() > 0);

    // ---- 3. 正确密码 ----
    await p.fill('.auth-overlay input[type="password"]', PASSWORD);
    await p.click('.auth-submit');
    let gone = true;
    try { await overlay.waitFor({ state: 'detached', timeout: 15000 }); }
    catch { gone = false; }
    check('正确密码登录后遮罩消失', gone);

    // 应用正常进入（Cookie 已生效，后续 API 不再 401）
    let shell = false;
    try {
        await p.locator('.nav-btn[data-view="sources"]').waitFor({ state: 'visible', timeout: 15000 });
        shell = true;
    } catch {}
    check('登录后应用正常进入', shell);

    const authed = await p.evaluate(async () => {
        const d = await (await fetch('/api/auth/status')).json();
        return { required: d.required, authed: d.authed };
    });
    check('门禁状态显示已通过', authed.required === true && authed.authed === true,
          JSON.stringify(authed));

    check('无 JS 运行时错误', errs.length === 0, errs.slice(0, 3).join(' | '));
    // 唯一的 401 应该是「故意输错密码」那次登录；登录后不该再有被拒的请求
    const unexpected = http401.filter(u => u !== '/api/auth/login');
    check('登录后没有接口被门禁拒绝', unexpected.length === 0,
          unexpected.join(', ') || '（仅故意输错密码那次 401）');

    await b.close();
    finish();
}

function finish() {
    for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
    console.log('\n' + '='.repeat(62));
    for (const l of PASS) console.log('  [PASS] ' + l);
    for (const l of FAIL) console.log('  [FAIL] ' + l);
    console.log('='.repeat(62));
    console.log(`结果：${PASS.length} 通过 / ${FAIL.length} 失败`);
    try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
    process.exit(FAIL.length ? 1 : 0);
}

main().catch(e => { console.error('测试异常:', e); finish(); });
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch {} } });
