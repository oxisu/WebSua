/**
 * 浏览器端验收：三断点截图 + 主题切换 + 控制台错误检查。
 * 用本机已装的 Chromium（Playwright 缓存），避免重新下载。
 */
const path = require('path');
const fs = require('fs');

const { chromiumPath } = require('./browser-env.js');
const EXECUTABLE = chromiumPath();
const BASE = 'http://127.0.0.1:8792/';
const OUT = path.join(__dirname, '..', 'screenshots');

const VIEWPORTS = [
    { name: '01-desktop-1440', width: 1440, height: 900, desc: '桌面 1440×900' },
    { name: '02-tablet-834', width: 834, height: 1112, desc: '平板 834×1112' },
    { name: '03-mobile-390', width: 390, height: 844, desc: '手机 390×844' },
];

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const { chromium } = require('playwright-core');

    const browser = await chromium.launch({
        executablePath: EXECUTABLE,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    });

    const errors = [];
    let pass = 0, fail = 0;
    const check = (label, cond, detail = '') => {
        if (cond) { pass++; console.log(`  [PASS] ${label}${detail ? '  ' + detail : ''}`); }
        else { fail++; console.log(`  [FAIL] ${label}  ${detail}`); }
    };

    for (const vp of VIEWPORTS) {
        console.log(`\n${'='.repeat(58)}\n${vp.desc}\n${'='.repeat(58)}`);
        const ctx = await browser.newContext({
            viewport: { width: vp.width, height: vp.height },
            deviceScaleFactor: 2,
            colorScheme: 'dark',
        });
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('console', m => { if (m.type() === 'error') pageErrors.push(m.text()); });
        page.on('pageerror', e => pageErrors.push('PAGEERROR: ' + e.message));

        await page.goto(BASE, { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(1800);

        // ---- 基础结构 ----
        const hasTopbar = await page.locator('.topbar').count();
        const hasFeed = await page.locator('.feed').count();
        const slides = await page.locator('.feed-item').count();
        const video = await page.locator('.cvp-video').count();
        check('顶栏渲染', hasTopbar === 1);
        check('视频流容器存在', hasFeed === 1);
        check('流条目已加载', slides > 0, `${slides} 条`);
        check('播放器已挂载', video === 1);

        // ---- 滚动吸附：必须「一屏一条」，不能把所有条目堆在一起 ----
        const snap = await page.evaluate(() => {
            const feed = document.querySelector('.feed');
            const cs = getComputedStyle(feed);
            const items = [...document.querySelectorAll('.feed-item')];
            const first = items[0]?.getBoundingClientRect();
            const second = items[1]?.getBoundingClientRect();
            return {
                scrollable: feed.scrollHeight > feed.clientHeight,
                scrollHeight: feed.scrollHeight,
                clientHeight: feed.clientHeight,
                itemCount: items.length,
                firstTop: first ? Math.round(first.top) : null,
                firstH: first ? Math.round(first.height) : null,
                secondTop: second ? Math.round(second.top) : null,
                snapType: cs.scrollSnapType,
            };
        });
        check('视频流可滚动（内容高于一屏）', snap.scrollable,
            `${snap.scrollHeight}px > ${snap.clientHeight}px`);
        check('条目高度 = 一屏高', Math.abs(snap.firstH - snap.clientHeight) <= 2,
            `条目 ${snap.firstH}px / 容器 ${snap.clientHeight}px`);
        // 相邻性：第二条的 top 应等于第一条的 bottom（容差 2px）
        // 注：条目的 top 含顶栏偏移，所以用「第一条底边」作基准而不是 firstTop
        const adjacentOk = snap.secondTop !== null &&
            Math.abs(snap.secondTop - (snap.firstTop + snap.firstH)) <= 2;
        check('第二条紧邻第一条（未堆叠）', adjacentOk,
            `第二条 top=${snap.secondTop}，第一条底=${snap.firstTop + snap.firstH}`);
        check('启用了滚动吸附', snap.snapType.includes('y'), snap.snapType);

        // ---- 断点专属布局 ----
        const tabbarVisible = await page.locator('.tabbar').isVisible().catch(() => false);
        const sidebarBox = await page.locator('.sidebar').boundingBox().catch(() => null);
        const queueVisible = await page.locator('.queue').isVisible().catch(() => false);

        if (vp.width < 640) {
            check('手机：显示底部标签栏', tabbarVisible);
            check('手机：侧栏收起为抽屉', sidebarBox === null || sidebarBox.x < 0,
                sidebarBox ? `x=${Math.round(sidebarBox.x)}` : '未在视口内');
        } else if (vp.width < 1024) {
            check('平板：隐藏底部标签栏', !tabbarVisible);
            check('平板：侧栏收窄为图标条', sidebarBox && sidebarBox.width < 80,
                sidebarBox ? `${Math.round(sidebarBox.width)}px` : 'null');
        } else {
            check('桌面：侧栏完整展开', sidebarBox && sidebarBox.width > 200,
                sidebarBox ? `${Math.round(sidebarBox.width)}px` : 'null');
            check('桌面：显示播放队列', queueVisible);
        }

        // ---- 侧栏数据源 ----
        const sourceRows = await page.locator('.source-item').count();
        check('侧栏列出数据源', sourceRows > 0, `${sourceRows} 项`);

        await page.screenshot({ path: path.join(OUT, `${vp.name}-feed.png`) });

        // ---- 视图互斥：切走后上一个视图必须完全隐藏（回归：className 被覆盖导致两个视图同屏）----
        await page.locator(vp.width < 640 ? '.tab[data-view="library"]' : '.nav-btn[data-view="library"]').click();
        await page.waitForTimeout(900);
        const feedHidden = await page.evaluate(() => {
            const e = document.getElementById('view-feed');
            return getComputedStyle(e).display === 'none' && e.getBoundingClientRect().height === 0;
        });
        check('切换后视频流完全隐藏', feedHidden);
        await page.locator(vp.width < 640 ? '.tab[data-view="feed"]' : '.nav-btn[data-view="feed"]').click();
        await page.waitForTimeout(700);

        // ---- 媒体库视图 ----
        if (vp.width < 640) {
            await page.locator('.tab[data-view="library"]').click();
        } else {
            await page.locator('.nav-btn[data-view="library"]').click();
        }
        await page.waitForTimeout(1400);
        const cards = await page.locator('.card').count();
        check('媒体库网格渲染', cards > 0, `${cards} 张卡片`);
        await page.screenshot({ path: path.join(OUT, `${vp.name}-library.png`) });

        // ---- 数据源视图 ----
        if (vp.width < 640) {
            await page.locator('.tab[data-view="sources"]').click();
        } else {
            await page.locator('.nav-btn[data-view="sources"]').click();
        }
        await page.waitForTimeout(1200);
        const srcCards = await page.locator('.src-card').count();
        const srcStats = await page.locator('.src-stat').first().textContent().catch(() => '');
        check('数据源卡片渲染', srcCards > 0, `${srcCards} 张`);
        check('数据源统计显示', /\d/.test(srcStats || ''), (srcStats || '').trim());
        await page.screenshot({ path: path.join(OUT, `${vp.name}-sources.png`) });

        // ---- 添加数据源弹窗 ----
        const addBtn = page.locator('.sources-wrap .btn-primary').first();
        if (await addBtn.count()) {
            await addBtn.click();
            await page.waitForTimeout(500);
            const modalFields = await page.locator('.modal .field').count();
            check('添加数据源弹窗', modalFields >= 4, `${modalFields} 个字段`);
            await page.screenshot({ path: path.join(OUT, `${vp.name}-modal.png`) });
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
        }

        // ---- 主题：亮色 ----
        await page.evaluate(() => localStorage.setItem('websua.theme', 'light'));
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        const theme = await page.evaluate(() => document.documentElement.dataset.theme);
        check('主题切换为亮色', theme === 'light', `data-theme=${theme}`);
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        check('亮色背景生效', bg.includes('244') || bg.includes('255'), bg);
        if (vp.width < 640) {
            await page.locator('.tab[data-view="library"]').click();
        } else {
            await page.locator('.nav-btn[data-view="library"]').click();
        }
        await page.waitForTimeout(1200);
        await page.screenshot({ path: path.join(OUT, `${vp.name}-light.png`) });

        // ---- 跟随系统 ----
        await page.evaluate(() => localStorage.setItem('websua.theme', 'auto'));
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(1200);
        const autoTheme = await page.evaluate(() => document.documentElement.dataset.theme);
        check('跟随系统解析为暗色', autoTheme === 'dark', `data-theme=${autoTheme}`);

        // ---- 控制台错误 ----
        const realErrors = pageErrors.filter(e =>
            !/favicon|Failed to load resource.*40[34]|net::ERR_ABORTED/i.test(e));
        check('无 JS 运行时错误', realErrors.length === 0,
            realErrors.slice(0, 2).join(' | '));

        await ctx.close();
    }

    await browser.close();
    console.log(`\n${'='.repeat(58)}`);
    console.log(`浏览器验收：${pass} 通过 / ${fail} 失败`);
    console.log(`截图目录：${OUT}`);
    console.log(`${'='.repeat(58)}`);
    process.exit(fail ? 1 : 0);
})().catch(e => {
    console.error('运行失败:', e.message);
    process.exit(2);
});
