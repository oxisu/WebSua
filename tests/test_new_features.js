/** 验收新增功能：设置面板、封面、不连播、PC 自适应、调试日志默认关。 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { chromiumPath } = require('./browser-env.js');
const EXEC = chromiumPath();
const BASE = 'http://127.0.0.1:8792/';

const PASS = [], FAIL = [];
const check = (l, c, d = '') => (c ? PASS : FAIL).push(l + (d ? '  ' + d : ''));

(async () => {
    const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

    await p.goto(BASE, { waitUntil: 'networkidle' });
    await p.waitForTimeout(2000);

    // 1. 默认不显示调试日志
    const debugVisible = await p.evaluate(() => {
        const el = document.querySelector('.cvp-debug-log');
        if (!el) return 'none';
        const cs = getComputedStyle(el);
        return cs.display === 'none' ? 'hidden' : 'visible';
    });
    check('调试日志默认隐藏', debugVisible !== 'visible', debugVisible);

    // 2. 设置面板开关
    await p.locator('[aria-label="设置"]').click();
    await p.waitForTimeout(400);
    const switches = await p.locator('.modal .switch-row').count();
    const switchLabels = await p.locator('.modal .switch-label b').allTextContents();
    check('设置面板打开（≥4 个开关）', switches >= 4, `${switches} 个`);
    check('含「自动连播」开关', switchLabels.some(t => t.includes('自动连播')));
    check('含「恢复上次播放」开关', switchLabels.some(t => t.includes('恢复上次播放')));
    check('自动连播默认关', await p.evaluate(() =>
        JSON.parse(localStorage.getItem('websua.settings') || '{}').autoNext !== true));
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);

    // 3. 媒体库封面（数据源开启 tg_mode 后才生成同名封面）
    //    先开启数据源 tg_mode 并触发扫描
    await p.evaluate(async () => {
        const d = await (await fetch('/api/sources')).json();
        const sid = d.sources[0].id;
        await fetch(`/api/sources/${sid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tg_mode: 1 }) });
        await fetch(`/api/sources/${sid}/scan`, { method: 'POST' });
    });
    // 等扫描完成
    await p.waitForTimeout(9000);
    await p.locator('.nav-btn[data-view="library"]').click();
    await p.waitForTimeout(1500);
    const posterInfo = await p.evaluate(() => {
        const cards = [...document.querySelectorAll('.card')];
        // 有「动画」名且加载出图的比例
        const named = cards.filter(c => /动画/.test(c.querySelector('.card-name')?.textContent || ''));
        const withImg = named.filter(c => c.querySelector('.card-thumb img')).length;
        return { named: named.length, withImg };
    });
    check('封面已加载（动画类卡片有图）', posterInfo.withImg >= 3, JSON.stringify(posterInfo));

    // 4. 播放器自适应：桌面下 wrapper 撑满 feed（非竖屏窄条）
    await p.locator('.nav-btn[data-view="feed"]').click();
    await p.waitForTimeout(1500);
    const geo = await p.evaluate(() => {
        const w = document.querySelector('.cvp-wrapper')?.getBoundingClientRect();
        const feed = document.querySelector('.feed')?.getBoundingClientRect();
        return w && feed ? { w: Math.round(w.width), fw: Math.round(feed.width) } : null;
    });
    check('播放器撑满可视区（自适应，非竖屏窄条）',
        geo && geo.w >= geo.fw * 0.9, JSON.stringify(geo));

    // 5. 无 JS 错误
    const realErrs = errs.filter(e => !/favicon|ERR_ABORTED|Failed to load resource.*40[34]/i.test(e));
    check('无 JS 运行时错误', realErrs.length === 0, realErrs.slice(0, 2).join(' | '));

    await b.close();

    console.log('\n=== 验收结果 ===');
    PASS.forEach(t => console.log('  [PASS]', t));
    FAIL.forEach(t => console.log('  [FAIL]', t));
    console.log(`\n${PASS.length} 通过 / ${FAIL.length} 失败`);
    process.exit(FAIL.length ? 1 : 0);
})().catch(e => { console.error('运行失败:', e.message); process.exit(2); });
