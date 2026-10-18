/** 全面 UI 审查：所有页面 × 所有按钮状态 × 三个断点。 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { chromiumPath } = require('./browser-env.js');
const EXEC = chromiumPath();
const BASE = 'http://127.0.0.1:8792/';
const OUT = path.join(__dirname, '..', 'screenshots', 'audit');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
    { name: 'desktop', width: 1440, height: 900, nav: '.nav-btn' },
    { name: 'tablet', width: 834, height: 1112, nav: '.nav-btn' },
    { name: 'mobile', width: 390, height: 844, nav: '.tab' },
];

(async () => {
    const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

    for (const vp of VIEWPORTS) {
        const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
        const page = await ctx.newPage();
        const errs = [];
        page.on('pageerror', e => errs.push(e.message));
        page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

        await page.goto(BASE, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);

        const nav = vp.nav;
        const shot = async (label) => page.screenshot({ path: path.join(OUT, `${vp.name}-${label}.png`) });

        // 1. 视频流
        await shot('01-feed');
        // 视频流：点开播放器更多菜单
        await page.locator('.cvp-more-btn').click().catch(() => {});
        await page.waitForTimeout(300);
        await shot('02-feed-more-menu');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);

        // 2. 媒体库
        await page.locator(`${nav}[data-view="library"]`).click();
        await page.waitForTimeout(1500);
        await shot('03-library');
        // 悬停卡片看收藏按钮
        const card = page.locator('.card').first();
        await card.hover().catch(() => {});
        await page.waitForTimeout(300);
        await shot('04-library-hover');

        // 3. 数据源
        await page.locator(`${nav}[data-view="sources"]`).click();
        await page.waitForTimeout(1200);
        await shot('05-sources');
        // 打开更多菜单
        await page.locator('.src-more .btn').first().click().catch(e => console.log('  [more click fail]', e.message.split(String.fromCharCode(10))[0]));
        await page.waitForTimeout(100);
        console.log('  [menu after click]', await page.evaluate(() => { const m = document.querySelector('.src-more-menu'); return m ? m.className + '|' + getComputedStyle(m).visibility : 'none'; }));
        await page.waitForTimeout(300);
        await shot('06-sources-more-menu');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        // 添加数据源弹窗
        await page.locator('.sources-wrap .btn-primary').first().click().catch(() => {});
        await page.waitForTimeout(500);
        await shot('07-source-editor');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);

        // 4. 设置弹窗
        await page.locator('[aria-label="设置"]').click().catch(() => {});
        await page.waitForTimeout(400);
        await shot('08-settings');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);

        // 5. 队列折叠
        await page.locator(`${nav}[data-view="feed"]`).click();
        await page.waitForTimeout(1000);
        if (vp.name === 'desktop') {
            await shot('09-queue-expanded');
            await page.locator('.queue-toggle').click().catch(() => {});
            await page.waitForTimeout(400);
            await shot('10-queue-collapsed');
        }

        // 6. 亮色主题
        await page.evaluate(() => localStorage.setItem('websua.theme', 'light'));
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(1200);
        await page.locator(`${nav}[data-view="sources"]`).click();
        await page.waitForTimeout(1000);
        await shot('11-light-sources');
        await page.locator(`${nav}[data-view="library"]`).click();
        await page.waitForTimeout(1200);
        await shot('12-light-library');
        await page.evaluate(() => localStorage.setItem('websua.theme', 'auto'));
        await page.reload({ waitUntil: 'networkidle' });

        console.log(`[${vp.name}] 截图完成，错误: ${errs.filter(e => !/favicon|ERR_ABORTED/i.test(e)).length}`);
        await ctx.close();
    }
    await b.close();
    console.log('全部完成');
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
