const path = require('path');
/** 验证：队列折叠态、Toast 位置/分色、扫描控制按钮。 */
const { chromium } = require('playwright-core');
const { chromiumPath } = require('./browser-env.js');
const EXEC = chromiumPath();
const OUT = path.join(__dirname, '..', 'screenshots');

const PASS = [], FAIL = [];
const check = (l, c, d = '') => (c ? PASS : FAIL).push(l + (d ? '  ' + d : ''));

(async () => {
    const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));

    await p.goto('http://127.0.0.1:8792/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(1800);

    // ---- 0. 清场：只取消**确实卡住**的遗留任务，且清场后重载。
    // 注意：清场绝不能放在扫描用例之后无条件执行 —— 会把刚暂停的任务
    // 「继续→立刻取消」，污染被测状态（scan.log 的时间线证明了这点）。
    await p.evaluate(async () => {
        const tasks = await (await fetch('/api/tasks')).json();
        const stale = (tasks.tasks || []).filter(t =>
            ['pending', 'running', 'paused'].includes(t.state));
        for (const t of stale) {
            await fetch(`/api/sources/${t.source_id}/scan/cancel`, { method: 'POST' }).catch(() => {});
        }
    });
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(1200);

    // ---- 1. 队列折叠 ----
    const before = await p.evaluate(() => {
        const q = document.querySelector('.queue');
        return { w: Math.round(q.getBoundingClientRect().width), refresh: !!document.querySelector('.queue-refresh') };
    });
    check('队列展开宽', before.w > 200, `${before.w}px`);
    await p.locator('.queue-toggle').click();
    await p.waitForTimeout(500);
    const after = await p.evaluate(() => {
        const q = document.querySelector('.queue');
        const refresh = getComputedStyle(document.querySelector('.queue-refresh')).display;
        const title = getComputedStyle(document.querySelector('.queue .side-title')).display;
        return { w: Math.round(q.getBoundingClientRect().width), refresh, title };
    });
    check('队列折叠变窄', after.w < 60, `${after.w}px`);
    check('折叠时隐藏重新随机按钮', after.refresh === 'none');
    check('折叠时隐藏标题', after.title === 'none');
    await p.screenshot({ path: OUT + '/CHECK-queue-collapsed.png' });
    await p.locator('.queue-toggle').click();   // 展开
    await p.waitForTimeout(400);

    // ---- 2. Toast：顶部弹出 + 分色 ----
    const toastPos = await p.evaluate(async () => {
        const { showToast } = await import('/js/utils.js');
        showToast('成功通知', 'ok');
        showToast('错误通知', 'err');
        showToast('警告通知', 'warn');
        showToast('普通提示', 'info');
        await new Promise(r => setTimeout(r, 350));
        const host = document.querySelector('.toasts');
        const cs = getComputedStyle(host);
        const toasts = [...document.querySelectorAll('.toast')].map(t => ({
            cls: t.className.replace('toast ', ''),
            icoBg: getComputedStyle(t.querySelector('.toast-ico')).backgroundColor,
            borderL: getComputedStyle(t).borderLeftColor,
        }));
        return { top: cs.top, bottom: cs.bottom, count: toasts.length, toasts };
    });
    check('Toast 在顶部弹出（top 定位）', toastPos.top !== 'auto' && parseInt(toastPos.top) < 200,
        `top=${toastPos.top}`);
    check('4 种类型都渲染', toastPos.count === 4, `${toastPos.count} 条`);
    const colors = new Set(toastPos.toasts.map(t => t.borderL));
    check('四条 Toast 颜色各不相同', colors.size === 4, `${colors.size} 种颜色`);
    const icoColors = new Set(toastPos.toasts.map(t => t.icoBg));
    check('图标底色分色', icoColors.size === 4);
    await p.screenshot({ path: OUT + '/CHECK-toast.png' });
    await p.waitForTimeout(3200);

    // ---- 3. 数据源页卡片信息 + 控制按钮 ----
    await p.locator('.nav-btn[data-view="sources"]').click();
    await p.waitForTimeout(1200);
    // 若上一段测试留下活动任务导致按钮禁用，再清一次
    if (await p.locator('.src-scan-btn').first().isDisabled()) {
        await p.evaluate(async () => {
            const d = await (await fetch('/api/sources')).json();
            for (const s of d.sources) {
                await fetch(`/api/sources/${s.id}/scan/cancel`, { method: 'POST' }).catch(() => {});
            }
        });
        await p.reload({ waitUntil: 'networkidle' });
        await p.waitForTimeout(1200);
        await p.locator('.nav-btn[data-view="sources"]').click();
        await p.waitForTimeout(800);
    }
    const cardInfo = await p.evaluate(() => {
        const card = document.querySelector('.src-card');
        if (!card) return null;
        return {
            urlLabel: !!card.querySelector('.src-url-label'),
            anon: !!card.querySelector('.pill-anon') || !!card.querySelector('.pill-auth'),
            stats: card.querySelectorAll('.src-stat').length,
            sizeShown: /MB|KB/.test(card.querySelector('.src-stats')?.textContent || ''),
        };
    });
    check('卡片显示完整地址（带标签）', cardInfo?.urlLabel);
    check('卡片显示认证方式', cardInfo?.anon);
    check('卡片四格统计', cardInfo?.stats === 4, `${cardInfo?.stats} 格`);
    check('卡片显示总大小', cardInfo?.sizeShown);

    // 扫描中显示暂停/停止/日志
    await p.locator('.src-scan-btn').first().click();
    await p.waitForTimeout(700);
    const ctl = await p.evaluate(() => {
        const c = document.querySelector('.src-status-ctl');
        if (!c) return null;
        const btns = [...c.querySelectorAll('button')].map(b => b.textContent.trim());
        return { has: true, btns };
    });
    check('扫描中出现控制按钮行', !!ctl, ctl ? ctl.btns.join('/') : '无');
    check('含暂停/继续', /暂停|继续/.test(ctl?.btns?.join('') || ''));
    check('含停止', /停止/.test(ctl?.btns?.join('') || ''));
    check('含日志', /日志/.test(ctl?.btns?.join('') || ''));
    // 暂停 → 验证 → 继续（本地扫描太快，停止来不及，暂停最可靠）
    // 注意：轮询每 1.5s 原地更新按钮文字，点击可能撞上内容替换 ——
    // 等一个轮询周期让节奏稳定，并用 force 点击保证命中当前位置。
    await p.waitForTimeout(1100);
    const pauseBtn = p.locator('.src-status-ctl button', { hasText: '暂停' });
    if (await pauseBtn.count()) {
        await pauseBtn.click({ force: true });
        await p.waitForTimeout(800);
        const pausedNow = await p.evaluate(() =>
            /已暂停/.test(document.querySelector('.src-card')?.textContent || ''));
        check('暂停后显示已暂停', pausedNow);
        const resumeBtn = p.locator('.src-status-ctl button', { hasText: '继续' });
        if (await resumeBtn.count()) {
            await resumeBtn.click({ force: true });
            await p.waitForTimeout(600);
            const resumed = await p.evaluate(() =>
                /扫描中/.test(document.querySelector('.src-card')?.textContent || ''));
            check('继续后恢复扫描中', resumed);
        }
    }
    // 等扫描自然完成
    await p.waitForTimeout(3500);

    const realErrs = errs.filter(e => !/favicon|ERR_ABORTED/i.test(e));
    check('无 JS 运行时错误', realErrs.length === 0, realErrs.slice(0, 2).join('|'));

    await b.close();
    console.log('\n=== 验证结果 ===');
    PASS.forEach(t => console.log('  [PASS]', t));
    FAIL.forEach(t => console.log('  [FAIL]', t));
    console.log(`\n${PASS.length} 通过 / ${FAIL.length} 失败`);
    process.exit(FAIL.length ? 1 : 0);
})().catch(e => { console.error('失败:', e.message); process.exit(2); });
