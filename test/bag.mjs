// test/bag.mjs — 回歸測試：藥裝在透明夾鏈袋裡、放在灰桌上拍（2026-10-26 組長實拍：10 顆被數成 53）
// 模擬袋子外框亮線（封閉的圈）、紅封口線、皺褶反光、角落亮斑；正確答案 10 顆。
//   node test/bag.mjs            → 印出結果，不是 10 顆就以非零碼結束
import fs from 'node:fs';
import path from 'node:path';
import { countPills } from '../counter.js';
import { encodePNG, drawMarkers } from './synth.mjs';
import { readPNG } from './png.mjs';

export function makeBagScene(seed = 1) {
  let s = seed >>> 0; const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  const w = 750, h = 1000, d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const v = 165 + rnd() * 8; d[i * 4] = v; d[i * 4 + 1] = v + 1; d[i * 4 + 2] = v - 4; d[i * 4 + 3] = 255; }
  const line = (x0, y0, x1, y1, wd, col) => { const n = Math.hypot(x1 - x0, y1 - y0) | 0; for (let t = 0; t <= n; t++) { const x = x0 + (x1 - x0) * t / n, y = y0 + (y1 - y0) * t / n; for (let dy = -wd; dy <= wd; dy++) for (let dx = -wd; dx <= wd; dx++) { const xx = (x + dx) | 0, yy = (y + dy) | 0; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; const p = (yy * w + xx) * 4; d[p] = col[0]; d[p + 1] = col[1]; d[p + 2] = col[2]; } } };
  const disc = (cx, cy, r, col) => { for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { const p = (y * w + x) * 4; d[p] = col[0]; d[p + 1] = col[1]; d[p + 2] = col[2]; } };
  line(120, 60, 640, 40, 5, [235, 235, 232]); line(640, 40, 660, 940, 4, [230, 232, 230]); line(120, 60, 100, 960, 4, [225, 226, 224]); line(100, 960, 660, 940, 5, [232, 232, 230]);
  line(130, 75, 630, 55, 5, [200, 60, 60]);
  line(140, 300, 520, 420, 3, [220, 222, 220]); line(200, 620, 600, 560, 5, [228, 228, 226]); line(160, 780, 300, 900, 2, [215, 217, 215]); line(560, 200, 640, 520, 6, [226, 226, 224]);
  disc(150, 900, 9, [240, 240, 238]); disc(620, 120, 7, [238, 238, 236]);
  const pills = [[400, 650], [445, 655], [490, 662], [420, 700], [465, 705], [510, 712], [440, 748], [485, 752], [380, 760], [530, 760]];
  for (const [x, y] of pills) disc(x, y, 20, [250, 250, 248]);
  const e = new Uint8ClampedArray(d);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) for (let c = 0; c < 3; c++) { let a = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) a += d[((y + dy) * w + x + dx) * 4 + c]; e[(y * w + x) * 4 + c] = a / 9; }
  return { img: { data: e, width: w, height: h }, truth: pills.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  let bad = 0;
  for (const seed of [1, 2, 3]) {
    const sc = makeBagScene(seed);
    const r = countPills(sc.img, {});
    const ok = r.count === sc.truth;
    if (!ok) bad++;
    console.log(`${ok ? 'OK ' : 'FAIL'} seed${seed} truth=${sc.truth} count=${r.count} unc=${r.pills.filter((p) => p.uncertain).length} R=${r.R.toFixed(1)} lines=${r.lines} warn=${r.warnings.join(',')}`);
    if (seed === 1) { const o = path.join(path.dirname(new URL(import.meta.url).pathname), 'out'); fs.mkdirSync(o, { recursive: true }); fs.writeFileSync(path.join(o, 'bag_seed1.png'), encodePNG(drawMarkers(sc.img, r.pills, r.R).data, sc.img.width, sc.img.height)); }
  }
  // 真實照片：10 顆白色圓錠裝在透明夾鏈袋、放灰桌上（2026-10-26 組長實拍，v1.2.1 分割法數成 10 但位置錯 3+3）
  const here = path.dirname(new URL(import.meta.url).pathname);
  for (const [file, truth] of [['real/bag10_white_tablets_in_zipbag.png', 10]]) {
    const img = readPNG(path.join(here, file));
    const t0 = performance.now();
    const r = countPills(img, {});
    const ms = performance.now() - t0;
    const ok = r.count === truth;
    if (!ok) bad++;
    console.log(`${ok ? 'OK ' : 'FAIL'} ${file} truth=${truth} count=${r.count} unc=${r.pills.filter((p) => p.uncertain).length} R=${r.R.toFixed(1)} mode=${r.tmode} warn=${r.warnings.join(',')} ${ms.toFixed(0)}ms`);
    fs.writeFileSync(path.join(here, 'out', path.basename(file)), encodePNG(drawMarkers(img, r.pills, r.R).data, img.width, img.height));
  }
  process.exit(bad ? 1 : 0);
}
