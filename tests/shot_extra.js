// 补拍：媒体库网格 + 设置面板
const { chromium } = require('playwright-core');
const path = require('path');
const browserEnv = require('./browser-env.js');

const BASE = 'http://127.0.0.1:8799';
const OUT = path.join(__dirname, '..', 'docs', 'images');

async function main() {
  const exec = browserEnv.chromiumPath();
  const browser = await chromium.launch(
    exec ? { executablePath: exec, headless: true } : { headless: true }
  );
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  // 点「媒体库」标签
  await page.click('text=媒体库').catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, 'desktop-library.png') });
  console.log('✓ desktop-library.png');

  // 设置面板（齿轮图标）
  const gear = page.locator('header button, .top-bar button, .app-header button').last();
  // 更精确：找带 ⚙ 或 svg 的按钮
  const settingsBtn = page.locator('button[title*="设置"], button[aria-label*="设置"], .settings-btn, button:has(svg[data-icon="settings"])').first();
  try {
    if (await settingsBtn.count()) {
      await settingsBtn.click();
    } else {
      // 顶栏最后几个 button 里找齿轮
      const btns = page.locator('.app-header button, header button');
      const n = await btns.count();
      if (n > 0) await btns.nth(n - 2).click(); // 倒数第二个可能是齿轮
    }
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'desktop-settings.png') });
    console.log('✓ desktop-settings.png');
    await page.keyboard.press('Escape').catch(() => {});
  } catch (e) {
    console.log('settings skip:', e.message);
  }

  await browser.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
