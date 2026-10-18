/**
 * 浏览器测试共用：解析本机 Chromium 可执行文件路径。
 *
 * 去敏说明：历史版本曾把 "C:/Users/<用户名>/AppData/Local/ms-playwright/..."
 * 硬编码进每个测试文件（泄漏本机用户名与机器专属路径）。这里改为：
 *   1) 优先读 PLAYWRIGHT_CHROME 环境变量；
 *   2) 否则在 os.homedir() 下的 ms-playwright 缓存中自动找最新的 chromium。
 * 文件中不含任何个人专属路径。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

function chromiumPath() {
    if (process.env.PLAYWRIGHT_CHROME) return process.env.PLAYWRIGHT_CHROME;
    const base = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
    if (!fs.existsSync(base)) return '';
    const dirs = fs.readdirSync(base).filter(d => d.startsWith('chromium-')).sort();
    for (let i = dirs.length - 1; i >= 0; i--) {
        const p = path.join(base, dirs[i], 'chrome-win64', 'chrome.exe');
        if (fs.existsSync(p)) return p;
    }
    return '';
}

module.exports = { chromiumPath };
