/** 验证队列（播放列表）与媒体库的分页逻辑。 */
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
    await p.waitForTimeout(2000);

    // 队列第一页：≤24 条 + 底部分页状态
    const q1 = await p.evaluate(() => ({
        items: document.querySelectorAll('.q-item').length,
        foot: document.querySelector('.queue-foot')?.textContent.trim() || '',
        listScrollable: (() => {
            const l = document.querySelector('.queue-list');
            return l.scrollHeight > l.clientHeight;
        })(),
    }));
    check('队列第一页 ≤24 条', q1.items <= 24, `${q1.items} 条`);
    check('队列有分页提示', /加载更多|全部/.test(q1.foot), q1.foot);

    // 滚动到底自动加载，直到「已加载全部」
    let finalItems = q1.items;
    let finalFoot = q1.foot;
    for (let i = 0; i < 5; i++) {
        const s = await p.evaluate(() => {
            const list = document.querySelector('.queue-list');
            list.scrollTop = list.scrollHeight;
            return { items: document.querySelectorAll('.q-item').length,
                     foot: document.querySelector('.queue-foot')?.textContent.trim() || '' };
        });
        await p.waitForTimeout(900);
        const after = await p.evaluate(() => ({
            items: document.querySelectorAll('.q-item').length,
            foot: document.querySelector('.queue-foot')?.textContent.trim() || '',
        }));
        if (after.items === s.items && /全部/.test(after.foot)) { finalItems = after.items; finalFoot = after.foot; break; }
        finalItems = after.items; finalFoot = after.foot;
        if (/全部/.test(after.foot)) break;
    }
    check('滚动到底触发加载', finalItems > q1.items, `${q1.items} → ${finalItems} 条`);
    check('最终显示已加载全部', /全部/.test(finalFoot), finalFoot);

    // 媒体库分页
    await p.locator('.nav-btn[data-view="library"]').click();
    await p.waitForTimeout(1500);
    const l1 = await p.evaluate(() => ({
        cards: document.querySelectorAll('.card').length,
        foot: document.querySelector('.load-more')?.textContent.trim() || '',
    }));
    check('媒体库分页提示', /加载更多|全部/.test(l1.foot), l1.foot);
    check('媒体库第一页 ≤48 条', l1.cards <= 48, `${l1.cards} 条`);

    await b.close();
    console.log(`\n${PASS.length} 通过 / ${FAIL.length} 失败`);
    PASS.forEach(t => console.log('  [PASS]', t));
    FAIL.forEach(t => console.log('  [FAIL]', t));
    process.exit(FAIL.length ? 1 : 0);
})().catch(e => { console.error('失败:', e.message); process.exit(2); });
