/** 验证：停用数据源后，媒体列表/视频流/队列立即排除该源内容。 */
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
    await p.waitForTimeout(2500);

    // 确保已扫描（有内容）
    await p.evaluate(async () => {
        const d = await (await fetch('/api/sources')).json();
        const s = d.sources[0];
        if (s && !s.item_count) {
            await fetch(`/api/sources/${s.id}/scan`, { method: 'POST' });
        }
    });
    await p.waitForTimeout(10000);   // 等扫描完成（~7.5s）

    // 基线：媒体列表有内容
    const base = await p.evaluate(async () => {
        const m = await (await fetch('/api/media?kinds=video&limit=200')).json();
        return { total: m.total, ids: m.media.slice(0, 5).map(x => x.id) };
    });
    check('基线：媒体库有内容', base.total > 0, `${base.total} 个`);

    // 通过 UI 停用数据源（走真实交互链路）
    await p.locator('.nav-btn[data-view="sources"]').click();
    await p.waitForTimeout(1200);
    const sw = p.locator('.src-switch input').first();
    const wasEnabled = await sw.isChecked();
    await sw.click({ force: true });   // 停用
    await p.waitForTimeout(2000);      // onChanged → feed.setFilter → 重新加载

    // 1. 后端媒体查询应排除停用源
    const after = await p.evaluate(async () => {
        const m = await (await fetch('/api/media?kinds=video&limit=200')).json();
        return { total: m.total };
    });
    check('停用后媒体查询排除该源', after.total === 0, `${base.total} → ${after.total}`);

    // 2. 视频流列表也应刷新（feed.setFilter 联动）
    await p.locator('.nav-btn[data-view="feed"]').click();
    await p.waitForTimeout(2500);
    const feedState = await p.evaluate(() => ({
        slides: document.querySelectorAll('.feed-item').length,
        queueItems: document.querySelectorAll('.q-item').length,
    }));
    check('视频流已清空停用源内容', feedState.slides === 0, `${feedState.slides} 条`);
    check('队列已清空停用源内容', feedState.queueItems === 0, `${feedState.queueItems} 条`);

    // 3. 媒体库视图也应为空
    await p.locator('.nav-btn[data-view="library"]').click();
    await p.waitForTimeout(1500);
    const libCards = await p.evaluate(() => document.querySelectorAll('.card').length);
    check('媒体库已清空停用源内容', libCards === 0, `${libCards} 张`);

    // 4. 重新启用 → 内容恢复
    await p.locator('.nav-btn[data-view="sources"]').click();
    await p.waitForTimeout(1000);
    await sw.click({ force: true });   // 启用
    await p.waitForTimeout(2500);
    const restored = await p.evaluate(async () => {
        const m = await (await fetch('/api/media?kinds=video&limit=200')).json();
        return { total: m.total };
    });
    check('重新启用后内容恢复', restored.total === base.total, `${restored.total} 个`);

    // 恢复会话设置：清掉这次测试造成的会话（mediaId 可能指向停用期间的条目）
    await p.evaluate(() => localStorage.removeItem('websua.session'));

    await b.close();
    console.log(`\n${PASS.length} 通过 / ${FAIL.length} 失败`);
    PASS.forEach(t => console.log('  [PASS]', t));
    FAIL.forEach(t => console.log('  [FAIL]', t));
    process.exit(FAIL.length ? 1 : 0);
})().catch(e => { console.error('失败:', e.message); process.exit(2); });
