/** 全视图高清截图：逐个页面、逐个断点，用于审查排版问题。 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { chromiumPath } = require('./browser-env.js');
const EXECUTABLE = chromiumPath();
const BASE = 'http://127.0.0.1:8792/';
const OUT = path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
    { name: 'desktop', width: 1440, height: 900, nav: '.nav-btn' },
    { name: 'tablet', width: 834, height: 1112, nav: '.nav-btn' },
    { name: 'mobile', width: 390, height: 844, nav: '.tab' },
];

(async () => {
    const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    for (const vp of VIEWPORTS) {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
        const page = await ctx.newPage();
        page.on('pageerror', e => console.log(`[${vp.name}] PAGEERROR:`, e.message));
        await page.goto(BASE, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);

        for (const view of ['feed', 'library', 'sources']) {
            const sel = `${vp.nav}[data-view="${view}"]`;
            await page.locator(sel).click();
            await page.waitForTimeout(1400);
            await page.screenshot({ path: path.join(OUT, `REVIEW-${vp.name}-${view}.png`) });
        }
        // 播放器控制条特写
        await page.locator(`${vp.nav}[data-view="feed"]`).click();
        await page.waitForTimeout(1200);
        await page.screenshot({ path: path.join(OUT, `REVIEW-${vp.name}-player.png`) });
        await ctx.close();
    }
    await browser.close();
    console.log('完成');
})().catch(e => { console.error(e.message); process.exit(1); });
