/**
 * 浏览器测试共用：解析本机 Chromium 可执行文件路径。
 *
 * 去敏说明：历史版本曾把 "C:/Users/<用户名>/AppData/Local/ms-playwright/..."
 * 硬编码进每个测试文件（泄漏本机用户名与机器专属路径）。这里统一改为：
 *   1) 优先读 PLAYWRIGHT_CHROME 环境变量；
 *   2) 否则在各平台 Playwright 缓存目录里自动找最新的 chromium
 *      （Windows / Linux / macOS 三种布局都支持 —— CI 才能开箱即跑）；
 *   3) 再退回系统 Chrome/Chromium（Linux CI 常见 /usr/bin/google-chrome）。
 * 文件中不含任何个人专属路径。
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

/** 各平台 Playwright 浏览器缓存根目录。 */
function cacheRoots() {
    const home = os.homedir();
    if (process.platform === 'win32') {
        return [
            path.join(home, 'AppData', 'Local', 'ms-playwright'),
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : '',
        ];
    }
    if (process.platform === 'darwin') {
        return [path.join(home, 'Library', 'Caches', 'ms-playwright')];
    }
    return [
        path.join(home, '.cache', 'ms-playwright'),
        process.env.PLAYWRIGHT_BROWSERS_PATH || '',
    ];
}

/** 某个 chromium-<rev> 目录下，可执行文件在各平台的相对路径。 */
function candidates(dir) {
    if (process.platform === 'win32') {
        return [
            path.join(dir, 'chrome-win64', 'chrome.exe'),
            path.join(dir, 'chrome-win', 'chrome.exe'),
        ];
    }
    if (process.platform === 'darwin') {
        return [
            path.join(dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
            path.join(dir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        ];
    }
    return [
        path.join(dir, 'chrome-linux', 'chrome'),
        path.join(dir, 'chrome-linux64', 'chrome'),
    ];
}

function chromiumPath() {
    if (process.env.PLAYWRIGHT_CHROME) return process.env.PLAYWRIGHT_CHROME;

    for (const base of cacheRoots()) {
        if (!base || !fs.existsSync(base)) continue;
        const dirs = fs.readdirSync(base)
            .filter(d => d.startsWith('chromium-'))
            .sort((a, b) => {
                // chromium-999 vs chromium-1234：按数字比，别按字符串比
                const na = parseInt(a.split('-')[1], 10) || 0;
                const nb = parseInt(b.split('-')[1], 10) || 0;
                return na - nb;
            });
        for (let i = dirs.length - 1; i >= 0; i--) {
            for (const p of candidates(path.join(base, dirs[i]))) {
                if (fs.existsSync(p)) return p;
            }
        }
    }

    // 最后尝试系统浏览器
    const system = process.platform === 'win32'
        ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
           'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']
        : process.platform === 'darwin'
            ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
            : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
    for (const p of system) {
        if (fs.existsSync(p)) return p;
    }
    return '';
}

module.exports = { chromiumPath };
