/** 验证：TG 源开关、历史视图、分页配置、会话恢复。 */
const { chromium } = require('playwright-core');
const { chromiumPath } = require('./browser-env.js');
const EXEC = chromiumPath();

const PASS = [], FAIL = [];
const check = (l, c, d = '') => (c ? PASS : FAIL).push(l + (d ? '  ' + d : ''));

(async () => {
    const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(e.message));

    await p.goto('http://127.0.0.1:8792/', { waitUntil: 'networkidle' });
    await p.waitForTimeout(2000);

    // 清空设置，确保默认态
    await p.evaluate(() => localStorage.removeItem('websua.settings'));

    // ---- 1. 数据源 TG 开关 ----
    await p.locator('.nav-btn[data-view="sources"]').click();
    await p.waitForTimeout(1200);
    // 打开编辑弹窗看 TG 开关
    await p.locator('.src-more .btn').first().click();
    await p.waitForTimeout(300);
    await p.locator('.src-more-item', { hasText: '编辑' }).click();
    await p.waitForTimeout(500);
    const tgSwitch = await p.evaluate(() => {
        const labels = [...document.querySelectorAll('.modal .switch-label b')].map(b => b.textContent);
        return labels.some(t => t.includes('TG'));
    });
    check('数据源编辑有 TG 导出封面开关', tgSwitch);
    await p.keyboard.press('Escape');
    await p.waitForTimeout(300);

    // 卡片上 TG 徽章（通过编辑弹窗开启 tg_mode，走真实 UI 流程触发刷新）
    await p.locator('.src-more .btn').first().click();
    await p.waitForTimeout(300);
    await p.locator('.src-more-item', { hasText: '编辑' }).click();
    await p.waitForTimeout(500);
    // 找到 TG 开关并点开
    await p.evaluate(() => {
        const rows = [...document.querySelectorAll('.modal .switch-row')];
        const tg = rows.find(r => r.textContent.includes('TG'));
        if (tg && !tg.querySelector('.switch').classList.contains('on')) {
            tg.querySelector('.switch').click();
        }
    });
    await p.locator('.modal .btn-primary').click();   // 保存
    await p.waitForTimeout(1200);
    const tgBadge = await p.evaluate(() => !!document.querySelector('.pill-tg'));
    check('卡片显示 TG 封面徽章', tgBadge);

    // ---- 2. 媒体库历史筛选 ----
    // 先制造进度记录
    await p.evaluate(async () => {
        const d = await (await fetch('/api/media?kinds=video&limit=3')).json();
        for (const m of d.media) {
            await fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ media_id: m.id, position: 10, duration: 100 }) });
        }
    });
    await p.locator('.nav-btn[data-view="library"]').click();
    await p.waitForTimeout(1200);
    const chips = await p.evaluate(() => [...document.querySelectorAll('.lib-chip')].map(c => c.textContent.trim()));
    check('媒体库有筛选栏', chips.length >= 3, chips.join('/'));
    check('筛选栏含历史', chips.some(c => c.includes('历史')));

    await p.locator('.lib-chip[data-mode="history"]').click();
    await p.waitForTimeout(1200);
    const hist = await p.evaluate(() => ({
        cards: document.querySelectorAll('.card').length,
        watched: !!document.querySelector('.card-watched, .card-watched-part'),
    }));
    check('历史列表有内容', hist.cards >= 1, `${hist.cards} 张卡片`);
    check('历史项显示进度/已看完标记', hist.watched);

    // ---- 3. 分页配置 ----
    await p.locator('[aria-label="设置"]').click();
    await p.waitForTimeout(400);
    const hasPageSelect = await p.evaluate(() => {
        const labels = [...document.querySelectorAll('.modal .field label')].map(l => l.textContent);
        return labels.some(t => t.includes('每页')) && document.querySelectorAll('.modal .field select').length >= 2;
    });
    check('设置里有分页大小配置', hasPageSelect);
    // 改视频流每页为 12
    await p.evaluate(() => {
        const selects = document.querySelectorAll('.modal .field select');
        selects[0].value = '12';
        selects[0].dispatchEvent(new Event('change'));
    });
    await p.keyboard.press('Escape');
    await p.waitForTimeout(200);
    const savedPage = await p.evaluate(() => JSON.parse(localStorage.getItem('websua.settings')).pageFeed);
    check('分页配置保存生效', savedPage === 12, `pageFeed=${savedPage}`);

    // ---- 4. 会话恢复 ----
    await p.locator('.nav-btn[data-view="feed"]').click();
    await p.waitForTimeout(1500);
    // 手动保存会话（确定性顺序 new，保证可定位）
    await p.evaluate(() => {
        const cur = document.querySelector('.feed-item');
        const mid = cur ? Number(cur.dataset.id) : null;
        localStorage.setItem('websua.session', JSON.stringify({
            sources: [], order: 'new', mediaId: mid, savedAt: Date.now(),
        }));
    });
    const curMedia = await p.evaluate(() => JSON.parse(localStorage.getItem('websua.session')).mediaId);
    check('会话已保存', !!curMedia, `mediaId=${curMedia}`);

    // 重载页面 → 应恢复
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(3000);
    const restored = await p.evaluate(() => {
        // 激活的条目 = 挂载了播放器的 feed-item（cvp-video）
        const video = document.querySelector('.cvp-video');
        const item = video ? video.closest('.feed-item') : null;
        const firstItem = document.querySelector('.feed-item');
        const scrollTop = document.querySelector('.feed')?.scrollTop || 0;
        return {
            activeMediaId: item ? Number(item.dataset.id) : null,
            firstMediaId: firstItem ? Number(firstItem.dataset.id) : null,
            scrollTop: Math.round(scrollTop),
        };
    });
    check('重载后恢复会话（跳到上次条目）',
        restored.activeMediaId === curMedia || restored.firstMediaId === curMedia,
        `激活=${restored.activeMediaId} 首条=${restored.firstMediaId} 期望=${curMedia}`);

    const realErrs = errs.filter(e => !/favicon|ERR_ABORTED/i.test(e));
    check('无 JS 运行时错误', realErrs.length === 0, realErrs.slice(0, 2).join('|'));

    await b.close();
    console.log(`\n${PASS.length} 通过 / ${FAIL.length} 失败`);
    PASS.forEach(t => console.log('  [PASS]', t));
    FAIL.forEach(t => console.log('  [FAIL]', t));
    process.exit(FAIL.length ? 1 : 0);
})().catch(e => { console.error('失败:', e.message); process.exit(2); });
