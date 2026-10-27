// 截图脚本：用 Playwright 截取 WebSua 界面，保存到 docs/images/
const { chromium } = require('playwright-core');
const path = require('path');
const browserEnv = require('./browser-env.js');

const BASE = 'http://127.0.0.1:8799';
const OUT = path.join(__dirname, '..', 'docs', 'images');

async function shoot(page, name, opts = {}) {
  const file = path.join(OUT, name + '.png');
  await page.screenshot({ path: file, fullPage: false, ...opts });
  console.log('✓', name + '.png');
}

async function main() {
  const exec = browserEnv.chromiumPath();
  console.log('chromium:', exec || '(auto)');
  const browser = await chromium.launch(
    exec ? { executablePath: exec, headless: true } : { headless: true }
  );
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  // 1. 桌面三栏 — 媒体库
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);
  await shoot(page, 'desktop-library');

  // 2. 视频流（点侧栏第一个「视频流」）
  const feedBtn = page.locator('nav button, .sidebar button, [data-view="feed"]').first();
  if (await feedBtn.count()) {
    await feedBtn.click().catch(() => {});
    await page.waitForTimeout(1500);
    await shoot(page, 'desktop-feed');
  }

  // 3. 数据源管理
  const srcBtn = page.locator('[data-view="sources"], nav button:has-text("数据源")').first();
  if (await srcBtn.count()) {
    await srcBtn.click().catch(() => {});
    await page.waitForTimeout(1000);
    await shoot(page, 'desktop-sources');
  }

  // 4. 设置面板
  const gearBtn = page.locator('.settings-gear, [data-action="settings"], button:has-text("⚙")').first();
  if (await gearBtn.count()) {
    await gearBtn.click().catch(() => {});
    await page.waitForTimeout(800);
    await shoot(page, 'desktop-settings');
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
  }

  // 5. 暗色主题
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
  });
  await page.waitForTimeout(500);
  await shoot(page, 'desktop-dark');

  // 6. 手机视口
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mp = await mobile.newPage();
  await mp.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  await mp.waitForTimeout(1500);
  await shoot(mp, 'mobile-library');

  await browser.close();
  console.log('Done. Saved to', OUT);
}

main().catch(e => { console.error(e.message); process.exit(1); });
