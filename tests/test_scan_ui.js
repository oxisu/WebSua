/**
 * 浏览器端验收：增量扫描 / 断点续扫的 UI（v1.5.0）。
 *
 * 前置：tests/run_all.py --env-only 已启动（假 WebDAV 8898 + 主服务 8792）。
 *
 * 覆盖：
 *  1. 没扫过的源：主按钮是「扫描」
 *  2. 扫完后：主按钮变「增量扫描」；再扫完成状态显示「未变 N」（未变项不写库）
 *  3. 扫描中状态区显示模式（增量扫描中）
 *  4. 「更多」菜单里有「全量重扫」
 *  5. 停止扫描 → 主按钮变「继续扫描」并出现「放弃」；放弃后回到「增量扫描」
 *  6. 无 JS 运行时错误
 */
const { chromium } = require('playwright-core');
const { chromiumPath } = require('./browser-env.js');
const EXEC = chromiumPath();
const BASE = 'http://127.0.0.1:8792/';

const PASS = [], FAIL = [];
const check = (l, c, d = '') => (c ? PASS : FAIL).push(l + (d ? '  ' + d : ''));

(async () => {
    const b = await chromium.launch({
        executablePath: EXEC,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

    await p.goto(BASE, { waitUntil: 'networkidle', timeout: 20000 });
    await p.waitForTimeout(1200);

    // ---- 清场，建一个指向 /批量（24 个目录）的源，不预扫 ----
    await p.evaluate(async () => {
        const d = await (await fetch('/api/sources')).json();
        for (const s of d.sources) {
            await fetch(`/api/sources/${s.id}`, { method: 'DELETE' });
        }
        await fetch('/api/sources', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: '增量UI源', base_url: 'http://127.0.0.1:8898/dav', root_path: '/批量',
            }),
        });
    });
    await p.evaluate(() => { try { localStorage.clear(); } catch {} });
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
    await p.locator('.nav-btn[data-view="sources"]').click();
    await p.waitForTimeout(1000);

    const scanBtn = () => p.locator('.src-scan-btn').first();
    const btnText = async () => (await scanBtn().textContent() || '').trim();
    const statusText = async () => {
        const n = await p.$('.src-card .src-status .src-status-text');
        return n ? (await n.textContent() || '').trim() : '';
    };

    // ---- 1. 没扫过：按钮是「扫描」 ----
    check('未扫描的源主按钮为「扫描」', (await btnText()) === '扫描', await btnText());

    // ---- 2. 首次全量扫描 ----
    await scanBtn().click();
    await p.waitForFunction(
        () => { const b = document.querySelector('.src-scan-btn'); return b && !b.disabled; },
        { timeout: 30000 });
    await p.waitForFunction(
        () => { const t = document.querySelector('.src-card .src-status .src-status-text'); return t && t.textContent.includes('扫描完成'); },
        { timeout: 30000 });
    const firstStatus = await statusText();
    check('首次全量扫描完成（24 个文件）',
        firstStatus.includes('共 24 个文件') && firstStatus.includes('新增 24'),
        firstStatus);
    check('扫完后主按钮变为「增量扫描」', (await btnText()) === '增量扫描', await btnText());
    const title = await scanBtn().getAttribute('title');
    check('增量按钮带说明 tooltip', !!title && title.includes('变化'), title || '');

    // ---- 3. 增量再扫：未变项不写库 ----
    await scanBtn().click();
    await p.waitForTimeout(600);
    const midStatus = await statusText();
    check('扫描中状态区显示「增量扫描中」', midStatus.includes('增量扫描中'), midStatus);
    await p.waitForFunction(
        () => { const b = document.querySelector('.src-scan-btn'); return b && !b.disabled; },
        { timeout: 30000 });
    await p.waitForFunction(
        () => { const t = document.querySelector('.src-card .src-status .src-status-text'); return t && t.textContent.includes('未变 24'); },
        { timeout: 30000 });
    const incStatus = await statusText();
    check('增量完成显示「未变 24」且没有新增/更新',
        incStatus.includes('未变 24') && !incStatus.includes('新增') && !incStatus.includes('更新'),
        incStatus);

    // ---- 4. 更多菜单里有「全量重扫」 ----
    await p.locator('.src-more > button').click();
    await p.waitForTimeout(300);
    const moreItems = await p.$$eval('.src-more-menu .src-more-item', ns => ns.map(n => n.textContent.trim()));
    check('更多菜单包含「全量重扫」', moreItems.some(t => t.includes('全量重扫')), moreItems.join(' / '));
    await p.keyboard.press('Escape');
    await p.locator('.feed, .app-main, body').first().click({ position: { x: 5, y: 5 } }).catch(() => {});

    // ---- 5. 停止 → 继续扫描 + 放弃 ----
    await scanBtn().click();           // 再来一次增量，中途停掉
    await p.waitForTimeout(1500);      // 限流 0.25s/目录，这会儿应该已经扫了几个
    const stopBtn = p.locator('.src-status-ctl .btn-danger').first();
    check('扫描中出现「停止」按钮', await stopBtn.count() > 0);
    if (await stopBtn.count()) {
        await stopBtn.click();
        await p.waitForFunction(
            () => { const t = document.querySelector('.src-card .src-status .src-status-text'); return t && t.textContent.includes('进度已保存'); },
            { timeout: 15000 });
        const cancelStatus = await statusText();
        check('停止后提示进度已保存', cancelStatus.includes('进度已保存'), cancelStatus);
        check('停止后主按钮变为「继续扫描」', (await btnText()) === '继续扫描', await btnText());
        const discard = p.locator('.src-actions .btn-ghost', { hasText: '放弃' }).first();
        check('出现「放弃」按钮', await discard.count() > 0);
        if (await discard.count()) {
            await discard.click();
            await p.waitForFunction(
                () => { const b = document.querySelector('.src-scan-btn'); return b && b.textContent.includes('增量扫描'); },
                { timeout: 15000 });
            check('放弃断点后回到「增量扫描」', (await btnText()) === '增量扫描', await btnText());
            const afterDiscard = await statusText();
            check('放弃后不再提示进度已保存', !afterDiscard.includes('进度已保存'), afterDiscard);
        }
    }

    check('无 JS 运行时错误', errs.length === 0, errs.slice(0, 3).join(' | '));

    await b.close();
    console.log('='.repeat(62));
    for (const l of PASS) console.log('  [PASS] ' + l);
    for (const l of FAIL) console.log('  [FAIL] ' + l);
    console.log(`结果：${PASS.length} 通过 / ${FAIL.length} 失败`);
    console.log('='.repeat(62));
    process.exit(FAIL.length ? 1 : 0);
})().catch(e => { console.error('测试执行异常：', e); process.exit(1); });
