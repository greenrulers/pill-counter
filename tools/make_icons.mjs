// tools/make_icons.mjs — 產生 PWA 圖示（純 Node，4x 超取樣抗鋸齒）
import fs from 'node:fs';
import { encodePNG } from '../test/synth.mjs';

function render(size, maskable) {
  const out = new Uint8ClampedArray(size * size * 4);
  const S = 4; // supersample
  const pad = maskable ? 0.1 : 0.0;
  const radius = maskable ? 0 : size * 0.22;
  const shapes = [ // 在 0..1 座標系
    { t: 'disc', x: 0.36, y: 0.38, r: 0.15, score: true },
    { t: 'disc', x: 0.68, y: 0.40, r: 0.15, score: false },
    { t: 'disc', x: 0.52, y: 0.66, r: 0.15, score: false },
    { t: 'capsule', x1: 0.20, y1: 0.76, x2: 0.40, y2: 0.62, hw: 0.065 },
    { t: 'check', x: 0.80, y: 0.78, r: 0.13 },
  ];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const px = (x + (sx + 0.5) / S), py = (y + (sy + 0.5) / S);
      const u = px / size, v = py / size;
      // 背景圓角方形
      let inside = true;
      if (!maskable) {
        const cx = Math.min(Math.max(px, radius), size - radius), cy = Math.min(Math.max(py, radius), size - radius);
        inside = (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius;
      }
      if (!inside) continue;
      // 漸層底色（藍綠）
      let cr = 15 + 30 * v, cg = 118 - 20 * v, cb = 110 + 20 * (1 - v);
      const uu = (u - pad) / (1 - 2 * pad), vv = (v - pad) / (1 - 2 * pad);
      for (const s of shapes) {
        if (s.t === 'disc') {
          const d = Math.hypot(uu - s.x, vv - s.y);
          if (d <= s.r) {
            const shade = 1 - 0.15 * (d / s.r) ** 2;
            cr = 250 * shade; cg = 250 * shade; cb = 245 * shade;
            if (s.score && Math.abs(vv - s.y) < 0.012) { cr *= 0.75; cg *= 0.75; cb *= 0.75; }
          }
        } else if (s.t === 'capsule') {
          const dx = s.x2 - s.x1, dy = s.y2 - s.y1, L2 = dx * dx + dy * dy;
          let t = ((uu - s.x1) * dx + (vv - s.y1) * dy) / L2; t = Math.max(0, Math.min(1, t));
          const d = Math.hypot(uu - (s.x1 + t * dx), vv - (s.y1 + t * dy));
          if (d <= s.hw) { if (t < 0.5) { cr = 235; cg = 90; cb = 70; } else { cr = 250; cg = 250; cb = 245; } }
        } else if (s.t === 'check') {
          const d = Math.hypot(uu - s.x, vv - s.y);
          if (d <= s.r) {
            cr = 34; cg = 197; cb = 94;
            // 勾勾：兩段線
            const lx = uu - s.x, ly = vv - s.y;
            const seg = (ax, ay, bx, by) => { const ddx = bx - ax, ddy = by - ay, l2 = ddx * ddx + ddy * ddy; let tt = ((lx - ax) * ddx + (ly - ay) * ddy) / l2; tt = Math.max(0, Math.min(1, tt)); return Math.hypot(lx - (ax + tt * ddx), ly - (ay + tt * ddy)); };
            if (seg(-0.065, 0.0, -0.015, 0.05) < 0.02 || seg(-0.015, 0.05, 0.07, -0.05) < 0.02) { cr = 255; cg = 255; cb = 255; }
          }
        }
      }
      r += cr; g += cg; b += cb; a += 255;
    }
    const q = (y * size + x) * 4, n = S * S;
    out[q] = r / n; out[q + 1] = g / n; out[q + 2] = b / n; out[q + 3] = a / n;
  }
  return out;
}
fs.mkdirSync('icons', { recursive: true });
for (const [name, size, maskable] of [['icon-180', 180, false], ['icon-192', 192, false], ['icon-512', 512, false], ['icon-512-maskable', 512, true]]) {
  fs.writeFileSync(`icons/${name}.png`, encodePNG(render(size, maskable), size, size));
  console.log('icons/' + name + '.png');
}
