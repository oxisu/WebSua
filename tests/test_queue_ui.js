/**
 * 浏览器端验收：播放队列 / 下一集（v1.4.0）。
 *
 * 前置：tests/run_all.py --env-only 已启动（假 WebDAV 8898 + 主服务 8792）。
 *
 * 覆盖：
 *  1. 从媒体库点开一集 → 视频流切成该目录自然序，队列按「第1集…第12集」生成
 *  2. 点中的那集高亮为 playing，序号与目录序一致
 *  3. 点队列里另一集 → 视频流滚过去、高亮跟随
 *  4. 拖拽排序 → 顺序真的变了，且当前播放项不变
 *  5. 随机 / 循环 / 清空 → 状态落库（GET /api/queue 可见）
 *  6. 清空后进入「连播已关闭」态，可手动重开
 *  7. 无 JS 运行时错误
 */
const path = require('path');
const { chromium } = require('playwright-core');
const { chromiumPath } = require('./browser-env.js');
const EXEC = chromiumPath();
const BASE = 'http://127.0.0.1:8792/';

const PASS = [], FAIL = [];
const check = (l, c, d = '') => (c ? PASS : FAIL).push(l + (d ? '  ' + d : ''));

(async () => {
    const b = await chromium.launch({
        executablePath: EXEC,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    });
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });

    await p.goto(BASE, { waitUntil: 'networkidle', timeout: 20000 });
    await p.waitForTimeout(1500);

    // ---- 清场并重建数据源（隔离实例，动的是 data-test） ----
    // 注意：必须重新加载页面 —— 启动时页面已从后端拉过队列状态，
    // 这里的 DELETE 只清了库，不清浏览器内存里的 mode/shuffle。
    const sid = await p.evaluate(async () => {
        const d = await (await fetch('/api/sources')).json();
        for (const s of d.sources) {
            await fetch(`/api/sources/${s.id}`, { method: 'DELETE' });
        }
        await fetch('/api/queue', { method: 'DELETE' });
        const r = await fetch('/api/sources', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: '队列UI源', base_url: 'http://127.0.0.1:8898/dav', root_path: '/' }),
        });
        const sid = (await r.json()).id;
        await fetch(`/api/sources/${sid}/scan`, { method: 'POST' });
        return sid;
    });
    // 清掉本地会话/设置，保证 reload 后是全新的启动状态
    await p.evaluate(() => { try { localStorage.clear(); } catch {} });
    await p.reload({ waitUntil: 'networkidle' });
    await p.waitForTimeout(1000);
    // 等**这个源**的扫描完成：必须按 source_id 匹配——/api/tasks 里还有
    // 上一轮测试遗留的 done 任务，按 found 数匹配会瞬间假阳性
    await p.waitForFunction(
        (sid) => fetch('/api/tasks').then(r => r.json()).then(d =>
            (d.tasks || []).some(t => t.source_id === sid && t.state === 'done')),
        sid, { timeout: 60000, polling: 500 });
    await p.waitForTimeout(800);

    // ---- 1. 从媒体库点开「第5集」 ----
    await p.locator('.nav-btn[data-view="library"]').click();
    await p.locator('.search input').fill('第5集');
    // 直接等目标卡片「可见」：库刚扫完卡片异步加载 + 搜索去抖过滤，
    // 不等地话 card.count() 会瞬间读到 0 而误判「找不到」（之前偶发失败根因）
    const card = p.locator('.card', { hasText: '第5集.mp4' }).first();
    let found = true;
    try { await card.waitFor({ state: 'visible', timeout: 15000 }); }
    catch { found = false; }
    check('媒体库里能找到第5集', found);
    await card.click();
    // 等队列真正生成（jumpToQueue → 拉目录自然序 → 渲染），不用固定 sleep
    await p.waitForFunction(
        () => document.querySelectorAll('#queueList .q-item').length === 12,
        { timeout: 20000, polling: 300 });

    // ---- 2. 队列按目录自然序生成 ----
    const titles = await p.$$eval('#queueList .q-item .q-title', ns => ns.map(n => n.textContent));
    check('队列按目录自然序生成（第1集…第12集）',
        titles.length === 12 && titles[0] === '第1集.mp4' && titles[1] === '第2集.mp4'
        && titles[9] === '第10集.mp4' && titles[11] === '第12集.mp4',
        `${titles.length} 项：${titles.slice(0, 3).join(',')}…`);

    const playing = await p.$$eval('#queueList .q-item.playing .q-title', ns => ns.map(n => n.textContent));
    check('点开的第5集高亮为当前播放', playing.length === 1 && playing[0] === '第5集.mp4',
        playing.join(','));

    const posText = await p.$$eval('#queueList .q-item.playing .q-pos', ns => ns.map(n => n.textContent));
    check('当前项序号为 5（与目录序一致）', posText[0] === '5', posText[0]);

    const count = await p.textContent('#queueCount');
    check('队列计数为 12', count === '12', count);

    // 视频流应已切成该目录的自然序列表：第5集是当前激活项
    const feedState = await p.evaluate(() => {
        const feed = document.querySelector('.feed');
        const h = feed.clientHeight;
        const idx = Math.round(feed.scrollTop / h);
        const title = document.querySelectorAll('.feed-title')[idx]?.textContent || '';
        return { idx, title, total: document.querySelectorAll('.feed-item').length };
    });
    check('视频流定位到第5集（目录自然序）', feedState.title === '第5集.mp4',
        JSON.stringify(feedState));
    check('视频流加载了整个目录（12 条）', feedState.total === 12, String(feedState.total));

    // ---- 3. 点队列里第9集 → 滚过去且高亮跟随 ----
    await p.locator('#queueList .q-item', { hasText: '第9集.mp4' }).first().click();
    // 高亮跟随 + 视频流真的滚到位（smooth 滚动要时间，两个条件都等）
    await p.waitForFunction(
        () => {
            if (document.querySelector('#queueList .q-item.playing .q-title')?.textContent !== '第9集.mp4') return false;
            const f = document.querySelector('.feed');
            if (!f) return false;
            const idx = Math.round(f.scrollTop / f.clientHeight);
            return document.querySelectorAll('.feed-title')[idx]?.textContent === '第9集.mp4';
        },
        { timeout: 20000, polling: 300 });
    const playing2 = await p.$$eval('#queueList .q-item.playing .q-title', ns => ns.map(n => n.textContent));
    const feedState2 = await p.evaluate(() => {
        const feed = document.querySelector('.feed');
        const idx = Math.round(feed.scrollTop / feed.clientHeight);
        return document.querySelectorAll('.feed-title')[idx]?.textContent || '';
    });
    check('点第9集后高亮跟随', playing2[0] === '第9集.mp4', playing2[0]);
    check('视频流滚到第9集', feedState2 === '第9集.mp4', feedState2);

    // ---- 3b. 「下一集」：点视频流的下一条导航，沿队列走到第10集 ----
    await p.locator('.feed-next').click();
    await p.waitForTimeout(2500);
    const nextEp = await p.evaluate(() => {
        const feed = document.querySelector('.feed');
        const idx = Math.round(feed.scrollTop / feed.clientHeight);
        return document.querySelectorAll('.feed-title')[idx]?.textContent || '';
    });
    const playingNext = await p.$$eval('#queueList .q-item.playing .q-title', ns => ns.map(n => n.textContent));
    check('下一条导航沿队列走到第10集（下一集）', nextEp === '第10集.mp4', nextEp);
    check('队列高亮跟随到第10集', playingNext[0] === '第10集.mp4', playingNext[0]);
    // 上一条回到第9集
    await p.locator('.feed-prev').click();
    await p.waitForTimeout(2500);
    const prevEp = await p.evaluate(() => {
        const feed = document.querySelector('.feed');
        const idx = Math.round(feed.scrollTop / feed.clientHeight);
        return document.querySelectorAll('.feed-title')[idx]?.textContent || '';
    });
    check('上一条导航沿队列回到第9集', prevEp === '第9集.mp4', prevEp);

    // ---- 4. 拖拽排序：把第1集拖到第3集位置 ----
    const before = await p.$$eval('#queueList .q-item .q-title', ns => ns.map(n => n.textContent));
    await p.locator('#queueList .q-item', { hasText: '第1集.mp4' }).first()
        .dragTo(p.locator('#queueList .q-item', { hasText: '第3集.mp4' }).first());
    await p.waitForTimeout(600);
    const after = await p.$$eval('#queueList .q-item .q-title', ns => ns.map(n => n.textContent));
    check('拖拽后顺序改变', JSON.stringify(before) !== JSON.stringify(after),
        `${before[0]}→${after[0]}`);
    check('拖拽后第1集落到第3集位置', after[2] === '第1集.mp4', after.slice(0, 4).join(','));
    const playing3 = await p.$$eval('#queueList .q-item.playing .q-title', ns => ns.map(n => n.textContent));
    check('拖拽不改变当前播放项', playing3[0] === '第9集.mp4', playing3[0]);

    // ---- 5. 随机 / 循环 / 清空 → 落库 ----
    await p.locator('#queueShuffle').click();
    await p.waitForTimeout(900);
    let q = await (await p.request.get(BASE + 'api/queue')).json();
    check('随机开关落库', q.queue.shuffle === true, JSON.stringify(q.queue.shuffle));
    await p.locator('#queueMode').click();   // off → all
    await p.waitForTimeout(900);
    q = await (await p.request.get(BASE + 'api/queue')).json();
    check('循环模式 off→all 落库', q.queue.mode === 'all', q.queue.mode);
    await p.locator('#queueMode').click();   // all → one
    await p.waitForTimeout(900);
    q = await (await p.request.get(BASE + 'api/queue')).json();
    check('循环模式 all→one 落库', q.queue.mode === 'one', q.queue.mode);

    // 拖拽过的顺序也应落库
    const savedOrder = q.queue.ids.length;
    check('队列规模仍为 12', savedOrder === 12, String(savedOrder));

    await p.locator('#queueClear').click();
    await p.waitForTimeout(900);
    q = await (await p.request.get(BASE + 'api/queue')).json();
    check('清空后队列为空且连播关闭',
        q.queue.ids.length === 0 && q.queue.enabled === false,
        `ids=${q.queue.ids.length} enabled=${q.queue.enabled}`);
    const emptyTitle = await p.textContent('.queue-empty-title');
    check('空状态显示「连播已关闭」', emptyTitle === '连播已关闭', emptyTitle);

    // ---- 6. 手动重开 ----
    await p.locator('.queue-empty button').click();
    await p.waitForTimeout(2000);
    const titles2 = await p.$$eval('#queueList .q-item .q-title', ns => ns.map(n => n.textContent));
    check('手动重开后按当前视频重建队列', titles2.length === 12,
        `${titles2.length} 项`);
    q = await (await p.request.get(BASE + 'api/queue')).json();
    check('重开后 enabled 回到 true', q.queue.enabled === true);

    // ---- 7. 无 JS 错误 ----
    const realErrs = errs.filter(e => !/favicon|ERR_ABORTED|Failed to load resource.*40[34]|net::/i.test(e));
    check('无 JS 运行时错误', realErrs.length === 0, realErrs.slice(0, 2).join(' | '));

    await b.close();
    console.log('='.repeat(58));
    for (const l of PASS) console.log('  [PASS] ' + l);
    for (const l of FAIL) console.log('  [FAIL] ' + l);
    console.log(`结果：{PASS} 通过 / {FAIL} 失败`.replace('{PASS}', PASS.length).replace('{FAIL}', FAIL.length));
    console.log('='.repeat(58));
    process.exit(FAIL.length ? 1 : 0);
})().catch(e => { console.error('运行异常：', e); process.exit(2); });
