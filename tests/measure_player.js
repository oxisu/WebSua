/** 精确测量播放器布局，找出控制条被裁与按钮漂移的根因。 */
const { chromium } = require('playwright-core');
const { chromiumPath } = require('./browser-env.js');
const EXEC = chromiumPath();

(async () => {
    const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    for (const vp of [{ w: 390, h: 844, n: 'mobile' }, { w: 1440, h: 900, n: 'desktop' }]) {
        const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h } });
        const p = await ctx.newPage();
        await p.goto('http://127.0.0.1:8792/', { waitUntil: 'networkidle' });
        await p.waitForTimeout(1600);
        const m = await p.evaluate(() => {
            const g = s => {
                const e = document.querySelector(s);
                if (!e) return null;
                const r = e.getBoundingClientRect();
                const cs = getComputedStyle(e);
                return { y: Math.round(r.y), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width), pos: cs.position };
            };
            return {
                viewportH: innerHeight,
                topbar: g('.topbar'), tabbar: g('.tabbar'),
                feed: g('.feed'), item: g('.feed-item'),
                stage: g('.feed-stage'), wrapper: g('.cvp-wrapper'),
                video: g('.cvp-video'), controlsBottom: g('.cvp-controls-bottom'),
                controlsTop: g('.cvp-controls-top'), overlay: g('.feed-overlay'),
            };
        });
        console.log(`\n===== ${vp.n} ${vp.w}x${vp.h} =====`);
        for (const [k, v] of Object.entries(m)) {
            if (v) console.log(`  ${k.padEnd(15)} y=${String(v.y).padStart(4)} bottom=${String(v.bottom).padStart(4)} h=${String(v.h).padStart(4)} w=${String(v.w).padStart(4)} ${v.pos}`);
            else console.log(`  ${k}: 不存在`);
        }
        await ctx.close();
    }
    await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
