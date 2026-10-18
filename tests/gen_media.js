/** 用 MediaRecorder 生成真实的 webm 视频素材（VP8，Chromium 原生可解码）。
 *  输出到 tests/fixtures/，供假 WebDAV 加载 —— 随机字节假视频无法验证截帧。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { chromiumPath } = require('./browser-env.js');
const EXEC = chromiumPath();
const OUT = path.join(__dirname, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

const CLIPS = [
    { name: '动画 红.mp4',      color: '#e74c3c', ms: 1800 },
    { name: '动画 蓝绿.mp4',   color: '#00d4c8', ms: 1800 },
    { name: '动画 紫金.mp4', color: '#a56cff', ms: 1800 },
];

(async () => {
    const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
    const ctx = await b.newContext({ viewport: { width: 480, height: 270 }, deviceScaleFactor: 1 });
    const p = await ctx.newPage();

    for (const clip of CLIPS) {
        const b64 = await p.evaluate(async ({ color, ms }) => {
            const cv = document.createElement('canvas');
            cv.width = 480; cv.height = 270;
            document.body.append(cv);
            const g = cv.getContext('2d');
            const t0 = performance.now();
            // 画一个会动的图案，保证每帧内容不同
            const draw = () => {
                const t = (performance.now() - t0) / 1000;
                g.fillStyle = '#101319'; g.fillRect(0, 0, 480, 270);
                g.fillStyle = color;
                g.beginPath();
                g.arc(240 + 150 * Math.sin(t * 2.2), 135 + 60 * Math.cos(t * 1.7), 46, 0, 7);
                g.fill();
                g.strokeStyle = '#ffffff'; g.lineWidth = 4;
                g.strokeRect(20, 20, 440, 230);
            };
            draw();
            const stream = cv.captureStream(30);
            const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 500_000 });
            const chunks = [];
            rec.ondataavailable = e => e.data.size && chunks.push(e.data);
            const done = new Promise(r => rec.onstop = r);
            rec.start(100);
            const iv = setInterval(draw, 33);
            await new Promise(r => setTimeout(r, ms));
            clearInterval(iv);
            rec.stop();
            await done;
            cv.remove();
            const blob = new Blob(chunks, { type: 'video/webm' });
            const buf = new Uint8Array(await blob.arrayBuffer());
            let s = '';
            for (let i = 0; i < buf.length; i += 0x8000)
                s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
            return btoa(s);
        }, { color: clip.color, ms: clip.ms });

        fs.writeFileSync(path.join(OUT, clip.name.replace('.mp4', '.webm')), Buffer.from(b64, 'base64'));
        console.log('✓ 已生成', clip.name.replace('.mp4', '.webm'));
    }
    await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
