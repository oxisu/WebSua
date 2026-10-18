/** 生成与视频同名的 JPG 封面（模拟 TG 导出结构：video + 同名 .jpg）。 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { chromiumPath } = require('./browser-env.js');
const EXEC = chromiumPath();
const OUT = path.join(__dirname, 'fixtures');

const POSTERS = [
    { name: '动画 红.jpg', color: '#e74c3c', label: 'RED' },
    { name: '动画 蓝绿.jpg', color: '#00d4c8', label: 'CYAN' },
    { name: '动画 紫金.jpg', color: '#a56cff', label: 'PURPLE' },
];

(async () => {
    const b = await chromium.launch({ executablePath: EXEC, args: ['--no-sandbox'] });
    const ctx = await b.newContext({ viewport: { width: 320, height: 180 } });
    const p = await ctx.newPage();
    for (const poster of POSTERS) {
        const b64 = await p.evaluate(async ({ color, label }) => {
            const cv = document.createElement('canvas');
            cv.width = 320; cv.height = 180;
            document.body.append(cv);
            const g = cv.getContext('2d');
            const grad = g.createLinearGradient(0, 0, 320, 180);
            grad.addColorStop(0, '#101319');
            grad.addColorStop(1, color);
            g.fillStyle = grad;
            g.fillRect(0, 0, 320, 180);
            g.fillStyle = 'rgba(255,255,255,0.9)';
            g.font = 'bold 42px sans-serif';
            g.textAlign = 'center';
            g.fillText(label, 160, 100);
            g.strokeStyle = 'rgba(255,255,255,0.6)';
            g.lineWidth = 3;
            g.strokeRect(10, 10, 300, 160);
            const dataUrl = cv.toDataURL('image/jpeg', 0.85);
            cv.remove();
            return dataUrl.split(',')[1];
        }, { color: poster.color, label: poster.label });
        fs.writeFileSync(path.join(OUT, poster.name), Buffer.from(b64, 'base64'));
        console.log('✓', poster.name);
    }
    await b.close();
})().catch(e => { console.error(e.message); process.exit(1); });
