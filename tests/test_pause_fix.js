/** 验证暂停修复：乐观更新即时反馈 + cancel 不再误写「已继续」+ 客户端断开静默。 */
const { chromium } = require('playwright-core');
const { chromiumPath } = require('./browser-env.js');
const EXEC = chromiumPath();

const PASS = [], FAIL = [];
const check = (l, c, d = '') => (c ? PASS : FAIL).push(l + (d ? '  ' + d : ''));

(async () => {
    const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    p.on('pageerror', e => console.log('  [PAGEERROR]', e.message));

    await p.goto('http://127.0.0.1:8792/', { waitUntil: 'networkidle' });
    await p.locator('.nav-btn[data-view="sources"]').click();
    await p.waitForTimeout(1200);

    // 清场：取消遗留任务
    await p.evaluate(async () => {
        const tasks = await (await fetch('/api/tasks')).json();
        for (const t of (tasks.tasks || [])) {
            if (['pending', 'running', 'paused'].includes(t.state)) {
                await fetch(`/api/sources/${t.source_id}/scan/cancel`, { method: 'POST' }).catch(() => {});
            }
        }
    });
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);
    await p.locator('.nav-btn[data-view="sources"]').click();
    await p.waitForTimeout(800);

    // 记录日志行数基线
    const logBase = await p.evaluate(async () =>
        (await (await fetch('/api/scan-log')).json()).lines.length);

    // 开始扫描
    await p.locator('.src-scan-btn').first().click();
    await p.waitForTimeout(800);

    // 点暂停，立即（200ms 内）检查 UI 是否已切到暂停态（乐观更新）
    const t0 = Date.now();
    await p.locator('.src-status-ctl button', { hasText: '暂停' }).click({ force: true });
    let uiPausedAt = -1;
    for (let i = 0; i < 10; i++) {
        await p.waitForTimeout(60);
        const paused = await p.evaluate(() =>
            /已暂停/.test(document.querySelector('.src-card')?.textContent || ''));
        if (paused) { uiPausedAt = Date.now() - t0; break; }
    }
    check('点暂停 UI 立即反馈（乐观更新 <600ms）', uiPausedAt >= 0 && uiPausedAt < 600,
        uiPausedAt >= 0 ? `${uiPausedAt}ms` : '未出现');

    // 按钮应变「继续」
    const resumeVisible = await p.evaluate(() => {
        const btns = [...document.querySelectorAll('.src-status-ctl button')].map(x => x.textContent.trim());
        return btns.includes('继续');
    });
    check('暂停后按钮变「继续」', resumeVisible);

    // 后端确认 paused
    await p.waitForTimeout(800);
    const bePaused = await p.evaluate(async () => {
        const d = await (await fetch('/api/tasks')).json();
        const t = (d.tasks || []).find(t => ['running', 'paused'].includes(t.state));
        return t?.state;
    });
    check('后端任务确认 paused', bePaused === 'paused', bePaused);

    // 点「停止」→ 日志里不应出现「扫描已继续」（cancel 时的误导日志已修）
    // 注意：/api/scan-log 只返回尾部 200 行，不能用行数切片（窗口会滑动），按尾部内容判断
    await p.locator('.src-status-ctl button', { hasText: '停止' }).click({ force: true });
    await p.waitForTimeout(1800);
    const tail = await p.evaluate(async () => {
        const d = await (await fetch('/api/scan-log')).json();
        return d.lines.slice(-3).join('\n');
    });
    check('cancel 日志含「已取消」', tail.includes('已取消'), tail.split('\n').slice(-1)[0]);
    check('cancel 时日志不误写「扫描已继续」', !tail.includes('扫描已继续'), tail.split('\n').slice(-1)[0]);

    // 客户端断流静默：播放中 abort 请求，后台不应刷堆栈
    // （验证方式：拉一段流然后中断，后台日志由 handle_error 静默——这里只验证流端点可用）
    const streamOk = await p.evaluate(async () => {
        const d = await (await fetch('/api/media?kinds=video&limit=1')).json();
        if (!d.media?.length) return false;
        const ctrl = new AbortController();
        const r = await fetch(d.media[0].stream, { signal: ctrl.signal });
        await r.body.getReader().read();   // 读一块
        ctrl.abort();                       // 中断（模拟切视频）
        return r.ok;
    });
    check('流端点可拉取且可中断', streamOk);
    await p.waitForTimeout(500);

    // 清理：确认任务已取消
    await p.evaluate(async () => {
        const tasks = await (await fetch('/api/tasks')).json();
        for (const t of (tasks.tasks || [])) {
            if (['pending', 'running', 'paused'].includes(t.state)) {
                await fetch(`/api/sources/${t.source_id}/scan/cancel`, { method: 'POST' }).catch(() => {});
            }
        }
    });

    const realErrs = [];
    await b.close();
    console.log(`\n${PASS.length} 通过 / ${FAIL.length} 失败`);
    PASS.forEach(t => console.log('  [PASS]', t));
    FAIL.forEach(t => console.log('  [FAIL]', t));
    process.exit(FAIL.length ? 1 : 0);
})().catch(e => { console.error('失败:', e.message); process.exit(2); });
