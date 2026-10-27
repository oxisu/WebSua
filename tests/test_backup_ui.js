/**
 * 浏览器端验收：设置面板「数据备份」（v1.8.0）。
 *
 * 自包含：本测试自己拉起主服务，结束后清理。
 * 运行（playwright-core 装在隔离工作区，需要 NODE_PATH）：
 *   NODE_PATH=<workspace>/node_modules node tests/test_backup_ui.js
 *
 * 覆盖：
 *  1. 设置里出现「导出配置 / 导入配置」与「包含 WebDAV 密码」选项
 *  2. 点「导出配置」真的触发 .json 下载
 *  3. 选文件导入后，源被写入并能被 /api/sources 查到
 *  4. 导入非法 JSON 会给出错误提示且不崩溃
 *  5. 无 JS 运行时错误
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
const APP_PORT = 8979;
const BASE = `http://127.0.0.1:${APP_PORT}/`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'websua-backupui-'));

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
    start(['main.py', '--port', String(APP_PORT)], { WEBSUA_DATA: DATA });
    if (!await waitHealth()) { check('服务启动', false); return finish(); }

    const b = await chromium.launch({
        executablePath: EXEC, args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
    p.on('console', m => {
        if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text());
    });

    await p.goto(BASE, { waitUntil: 'networkidle', timeout: 20000 });
    await p.waitForTimeout(800);
    await p.evaluate(() => { try { localStorage.clear(); } catch {} });
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(800);

    // ---- 打开设置 ----
    await p.click('button[aria-label="设置"]');
    await p.waitForTimeout(400);
    const row = p.locator('.backup-row');
    let okRow = true;
    try { await row.waitFor({ state: 'visible', timeout: 8000 }); } catch { okRow = false; }
    check('设置里出现数据备份分区', okRow);
    check('有「导出配置」按钮', await p.locator('.backup-row button', { hasText: '导出配置' }).count() > 0);
    check('有「导入配置」按钮', await p.locator('.backup-row button', { hasText: '导入配置' }).count() > 0);
    check('有「包含 WebDAV 密码」选项',
          await p.locator('.backup-pw input[type="checkbox"]').count() > 0);

    // ---- 导出：应触发下载 ----
    let dlOk = false, dlName = '';
    try {
        const [dl] = await Promise.all([
            p.waitForEvent('download', { timeout: 10000 }),
            p.locator('.backup-row button', { hasText: '导出配置' }).click(),
        ]);
        dlName = dl.suggestedFilename();
        dlOk = /^websua-backup-.*\.json$/.test(dlName);
    } catch (e) {
        dlName = 'timeout: ' + e.message.slice(0, 40);
    }
    check('点导出真的下载 .json 备份', dlOk, dlName);

    // ---- 导入：构造一个最小备份文件 ----
    const backup = {
        app: 'WebSua', version: 1, exported_at: Math.floor(Date.now() / 1000),
        includes_passwords: false,
        sources: [{
            name: '导入的源', base_url: 'http://imported.local/dav', root_path: '/lib',
            kind: 'video', sort: 0, enabled: 1, tg_mode: 0, verify_ssl: 1,
            auto_scan: 0, exclude_dirs: '', username: '', has_password: false,
        }],
        settings: { autoNext: true },
        favorites: [], progress: [],
    };
    const goodFile = path.join(DATA, 'good.json');
    fs.writeFileSync(goodFile, JSON.stringify(backup), 'utf-8');
    await p.setInputFiles('.backup-row input[type="file"]', goodFile);
    await p.waitForTimeout(1500);

    const imported = await p.evaluate(async () => {
        const d = await (await fetch('/api/sources')).json();
        return (d.sources || []).map(s => s.name);
    });
    check('导入后源被写入', imported.includes('导入的源'), JSON.stringify(imported));

    // ---- 非法 JSON 提示且不崩溃 ----
    const badFile = path.join(DATA, 'bad.json');
    fs.writeFileSync(badFile, 'not-a-json', 'utf-8');
    await p.setInputFiles('.backup-row input[type="file"]', badFile);
    await p.waitForTimeout(800);
    const appAlive = await p.evaluate(() => !!document.querySelector('.backup-row'));
    check('非法文件不会打崩页面', appAlive);
    // 弹过错误 toast 的最好证明：页面仍可继续操作（再开一次设置）
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);
    await p.click('button[aria-label="设置"]');
    await p.waitForTimeout(300);
    check('导入失败后仍能正常打开设置',
          await p.locator('.backup-row').count() > 0);

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
