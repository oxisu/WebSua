/**
 * 浏览器端验收：失败目录重扫的 UI（v1.6.0）。
 *
 * 自包含：本测试自己拉起假 WebDAV（带坏目录）+ 主服务，结束后清理。
 * 运行（playwright-core 装在隔离工作区，需要 NODE_PATH）：
 *   NODE_PATH=<workspace>/node_modules node tests/test_failed_dirs_ui.js
 *
 * 覆盖：
 *  1. 全量扫描遇到坏目录后，源卡片出现「N 目录失败」红色徽标
 *  2. 出现「重扫失败目录」按钮
 *  3. 修复坏目录后点「重扫失败目录」，徽标消失、媒体总数补齐、无 JS 错误
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
const DAV_PORT = 8968;
const APP_PORT = 8969;
const BASE = `http://127.0.0.1:${APP_PORT}/`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'websua-failui-'));

const PASS = [], FAIL = [];
const check = (l, c, d = '') => (c ? PASS : FAIL).push(l + (d ? '  ' + d : ''));
const procs = [];

function start(args, envExtra) {
    const env = { ...process.env, ...envExtra };
    const p = spawn(PY, args, { cwd: ROOT, env, stdio: 'ignore' });
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
    // 带坏目录的假 WebDAV（/视频/ 列举失败）+ 主服务
    start(['tests/fake_dav.py', String(DAV_PORT), 'good'],
          { WEBSUA_BROKEN_DIRS: '/视频/' });
    start(['main.py', '--port', String(APP_PORT)], { WEBSUA_DATA: DATA });
    if (!await waitHealth()) { check('服务启动', false); return finish(); }

    const b = await chromium.launch({
        executablePath: EXEC, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

    await p.goto(BASE, { waitUntil: 'networkidle', timeout: 20000 });
    await p.waitForTimeout(1000);
    await p.evaluate(async () => {
        const d = await (await fetch('/api/sources')).json();
        for (const s of d.sources) await fetch(`/api/sources/${s.id}`, { method: 'DELETE' });
        localStorage.clear();
    });
    // 建源（先建再刷新，卡片才会渲染出来）
    await p.evaluate((dav) => fetch('/api/sources', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '失败UI源', base_url: `http://127.0.0.1:${dav}/dav`, root_path: '/' }),
    }), DAV_PORT);
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(800);
    await p.locator('.nav-btn[data-view="sources"]').click();
    await p.waitForTimeout(800);

    await p.locator('.src-card').first().waitFor({ state: 'visible', timeout: 15000 });
    await p.locator('.src-scan-btn').first().click();
    // 等扫描按钮恢复可用 = 扫描结束
    await p.waitForFunction(
        () => { const x = document.querySelector('.src-scan-btn'); return x && !x.disabled; },
        { timeout: 60000 });
    await p.waitForTimeout(800);

    // ---- 1. 失败徽标 ----
    const failBadge = await p.$('.src-card .pill-fail');
    check('失败目录出现红色徽标', !!failBadge, await (failBadge?.textContent() || '无'));
    // ---- 2. 重扫失败目录按钮 ----
    const rescanBtn = p.locator('.src-rescan-failed').first();
    check('出现「重扫失败目录」按钮', await rescanBtn.count() > 0);

    const before = await p.evaluate(async () => {
        const d = await (await fetch('/api/sources')).json();
        const s = d.sources[0];
        return { failed: (s.failed_dirs || []).length, total: s.counts.all };
    });
    check('扫描后记录到失败目录', before.failed >= 1, JSON.stringify(before));

    // ---- 3. 修复坏目录：重启假 WebDAV（不带 WEBSUA_BROKEN_DIRS），重新扫描失败目录 ----
    procs[0].kill('SIGKILL');
    await new Promise(r => setTimeout(r, 500));
    start(['tests/fake_dav.py', String(DAV_PORT), 'good']);  // 不带坏目录
    // 等新假服务器真的起来了（任意响应即代表端口已可用）
    let davUp = false;
    for (let i = 0; i < 40 && !davUp; i++) {
        try { await fetch(`http://127.0.0.1:${DAV_PORT}/dav/`); davUp = true; } catch { await new Promise(r => setTimeout(r, 300)); }
    }
    check('修复后的假 WebDAV 已重启', davUp);

    await rescanBtn.click();
    // Node 侧轮询：等到 mode=failed 的任务出现并终结（不依赖按钮 disabled 启发式）
    let finalTask = null;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        try {
            const t = await (await fetch(BASE + 'api/tasks')).json();
            const k = (t.tasks || [])[0];
            if (k && k.mode === 'failed'
                && ['done', 'failed', 'cancelled'].includes(k.state)) { finalTask = k; break; }
        } catch {}
        await new Promise(r => setTimeout(r, 300));
    }
    check('重扫失败目录任务完成', finalTask && finalTask.state === 'done',
          JSON.stringify(finalTask ? { state: finalTask.state, mode: finalTask.mode, added: finalTask.added } : null));
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(800);
    await p.locator('.nav-btn[data-view="sources"]').click();
    await p.waitForTimeout(800);

    const after = await p.evaluate(async () => {
        const d = await (await fetch('/api/sources')).json();
        const s = d.sources[0];
        return { failed: (s.failed_dirs || []).length, total: s.counts.all };
    });
    check('重扫后失败目录清空（徽标消失）', after.failed === 0, JSON.stringify(after));
    check('重扫后失败徽标不再渲染', (await p.$('.src-card .pill-fail')) === null);
    check('重扫补齐了原失败目录下的媒体（总数增加）', after.total > before.total,
          `${before.total} → ${after.total}`);

    check('无 JS 运行时错误', errs.length === 0, errs.slice(0, 3).join(' | '));

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
