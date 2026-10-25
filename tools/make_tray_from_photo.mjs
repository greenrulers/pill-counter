// tools/make_tray_from_photo.mjs — 用真實藥錠照片（例如食藥署藥品外觀圖，淺色底單顆）合成模擬數藥托盤並直接計數
// 用法：node tools/make_tray_from_photo.mjs <輸出資料夾> <pill1.bmp> [pill2.bmp ...]
// 每種藥產生三張：稀疏 20 顆、相碰 30 顆、密集 60 顆；輸出 PNG、標記圖，並印出結果表
import fs from 'node:fs';
import path from 'node:path';
import { readBMP } from '../test/bmp.mjs';
import { encodePNG, drawMarkers, mulberry32 } from '../test/synth.mjs';
import { countPills, fillHolesCopy, labelComponents, openMask, dilate } from '../counter.js';

const outDir = process.argv[2];
const files = process.argv.slice(3);
fs.mkdirSync(outDir, { recursive: true });

// ---- 去背：以外框顏色為背景，顏色距離 → alpha；取最大連通元件、填洞 ----
function cutout(img) {
  const { data, width: w, height: h } = img;
  const bw = Math.max(2, Math.round(w * 0.04)), bh = Math.max(2, Math.round(h * 0.04));
  let sr = 0, sg = 0, sb = 0, c = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < bw || y < bh || x >= w - bw || y >= h - bh) { const p = (y * w + x) * 4; sr += data[p]; sg += data[p + 1]; sb += data[p + 2]; c++; }
  }
  const br = sr / c, bg = sg / c, bb = sb / c;
  // 藥錠：比紙亮（白錠）或色度與紙不同（有色錠）；比紙暗的（尺、文字、陰影）一律不算
  const Lp = 0.299 * br + 0.587 * bg + 0.114 * bb;
  const pcr = br - Lp, pcg = bg - Lp, pcb = bb - Lp;
  const alpha = new Float32Array(w * h), mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const L = 0.299 * r + 0.587 * g + 0.114 * b;
    let a = 0;
    if (L >= Lp - 60) { // 黑色的尺與文字（比紙暗很多）一律不算；陰影與白錠的暗面保留
      const d = Math.hypot(r - br, g - bg, b - bb);
      a = Math.max(0, Math.min(1, (d - 14) / 20));
    }
    alpha[i] = a; mask[i] = a > 0.5 ? 1 : 0;
  }
  // 食藥署外觀圖有 L 形毫米尺與文字：先開運算（半徑 3）去掉細線與小字，再挑「飽滿」（面積／外框面積高）的最大元件當藥
  const opened = openMask(mask, w, h, 3);
  const comps = labelComponents(opened, w, h, null).filter(c => {
    const bw2 = c.x1 - c.x0 + 1, bh2 = c.y1 - c.y0 + 1;
    const fill = c.area / (bw2 * bh2), aspect = Math.max(bw2, bh2) / Math.min(bw2, bh2);
    const frac = c.area / (w * h);
    return fill > 0.45 && aspect < 3.2 && frac > 0.0005 && frac < 0.15; // 排除尺的粗底線（細長）與文字
  });
  if (!comps.length) throw new Error('no pill found');
  const big = comps.reduce((a, b) => (b.area > a.area ? b : a));
  const core = new Uint8Array(w * h);
  const labels = labelComponents(opened, w, h, null).labels;
  for (let i = 0; i < w * h; i++) if (labels[i] === big.id) core[i] = 1;
  // 膨脹回去並與原始遮罩取交集，找回被開運算吃掉的邊緣；只保留含核心質心的那一塊（避免黏到旁邊的另一面）
  const grown = dilate(core, w, h, 2);
  const cand2 = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) cand2[i] = grown[i] && alpha[i] > 0.5 ? 1 : 0;
  const lab2 = labelComponents(cand2, w, h, null);
  const cid = lab2.labels[Math.round(big.cy) * w + Math.round(big.cx)] || (lab2.length ? lab2.reduce((a, b) => (b.area > a.area ? b : a)).id : 0);
  const only = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) only[i] = lab2.labels[i] === cid ? 1 : 0;
  const filled = fillHolesCopy(only, w, h);
  big.x0 = w; big.y0 = h; big.x1 = 0; big.y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (filled[y * w + x]) { if (x < big.x0) big.x0 = x; if (x > big.x1) big.x1 = x; if (y < big.y0) big.y0 = y; if (y > big.y1) big.y1 = y; }
  // 膨脹 1 像素保留邊緣的半透明
  const x0 = Math.max(0, big.x0 - 2), y0 = Math.max(0, big.y0 - 2), x1 = Math.min(w - 1, big.x1 + 2), y1 = Math.min(h - 1, big.y1 + 2);
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  let fa = 0; for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) fa += filled[y * w + x];
  const fillFinal = fa / (cw * ch);
  if (fillFinal < 0.55 || Math.max(cw, ch) / Math.min(cw, ch) > 3.5) throw new Error(`cutout not pill-like (fill ${fillFinal.toFixed(2)}, ${cw}x${ch})`);
  const out = new Float32Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const sx = x0 + x, sy = y0 + y, si = sy * w + sx, p = si * 4, q = (y * cw + x) * 4;
    let near = filled[si];
    if (!near) for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = sx + dx, yy = sy + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && filled[yy * w + xx]) { near = 1; break; } }
    const a = near ? (filled[si] ? Math.max(alpha[si], 0.6) : alpha[si]) : 0;
    out[q] = data[p]; out[q + 1] = data[p + 1]; out[q + 2] = data[p + 2]; out[q + 3] = a;
  }
  return { data: out, width: cw, height: ch };
}

// ---- 縮放（盒狀） ----
function resize(c, scale) {
  const w = Math.max(2, Math.round(c.width * scale)), h = Math.max(2, Math.round(c.height * scale));
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx0 = x / scale, sx1 = (x + 1) / scale, sy0 = y / scale, sy1 = (y + 1) / scale;
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let sy = Math.floor(sy0); sy < Math.min(c.height, Math.ceil(sy1)); sy++) for (let sx = Math.floor(sx0); sx < Math.min(c.width, Math.ceil(sx1)); sx++) {
      const p = (sy * c.width + sx) * 4; const wa = c.data[p + 3];
      r += c.data[p] * wa; g += c.data[p + 1] * wa; b += c.data[p + 2] * wa; a += wa; n++;
    }
    const q = (y * w + x) * 4;
    if (a > 0) { out[q] = r / a; out[q + 1] = g / a; out[q + 2] = b / a; }
    out[q + 3] = n ? a / n : 0;
  }
  return { data: out, width: w, height: h };
}

const TRAYS = [{ name: 'blue', c: [40, 70, 150] }, { name: 'black', c: [28, 28, 32] }, { name: 'green', c: [20, 80, 60] }];

function compose(cut, { W = 1000, H = 750, count, pTouch, tray, rng }) {
  const img = new Float32Array(W * H * 3);
  const ang = rng() * Math.PI * 2, gx = Math.cos(ang), gy = Math.sin(ang), gAmp = 0.05 + rng() * 0.12;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = (x / W - 0.5) * gx + (y / H - 0.5) * gy, f = 1 + gAmp * t * 2, p = (y * W + x) * 3;
    img[p] = tray.c[0] * f; img[p + 1] = tray.c[1] * f; img[p + 2] = tray.c[2] * f;
  }
  const effR = Math.hypot(cut.width, cut.height) / 2 * 0.92; // 外接圓（略縮，讓相碰時真的碰到）
  const margin = effR + 8;
  const pills = [];
  let tries = 0;
  while (pills.length < count && tries < 30000) {
    tries++;
    let x, y;
    if (pills.length && rng() < pTouch) {
      const a = pills[Math.floor(rng() * pills.length)], th = rng() * Math.PI * 2;
      const d = 2 * effR * (0.9 + rng() * 0.08);
      x = a.x + Math.cos(th) * d; y = a.y + Math.sin(th) * d;
    } else { x = margin + rng() * (W - 2 * margin); y = margin + rng() * (H - 2 * margin); }
    if (x < margin || y < margin || x > W - margin || y > H - margin) continue;
    let ok = true;
    for (const b of pills) { const dd = Math.hypot(b.x - x, b.y - y); if (dd < 2 * effR * 0.88) { ok = false; break; } if (dd < 2 * effR + 5 && dd > 2 * effR * 0.98) { ok = false; break; } }
    if (!ok) continue;
    pills.push({ x, y, rot: rng() * Math.PI * 2 });
  }
  const blend = (p, rot, dx, dy, shadow) => {
    const cos = Math.cos(rot), sin = Math.sin(rot), hw = cut.width / 2, hh = cut.height / 2, ext = effR / 0.92 + 2;
    for (let y = Math.max(0, Math.floor(p.y + dy - ext)); y <= Math.min(H - 1, Math.ceil(p.y + dy + ext)); y++)
      for (let x = Math.max(0, Math.floor(p.x + dx - ext)); x <= Math.min(W - 1, Math.ceil(p.x + dx + ext)); x++) {
        const rx = x - (p.x + dx), ry = y - (p.y + dy);
        const u = rx * cos + ry * sin + hw, v = -rx * sin + ry * cos + hh; // 反向旋轉到來源座標
        if (u < 0 || v < 0 || u >= cut.width - 1 || v >= cut.height - 1) continue;
        const ix = Math.floor(u), iy = Math.floor(v), fx = u - ix, fy = v - iy;
        const s = (xx, yy, k) => cut.data[(yy * cut.width + xx) * 4 + k];
        const bil = (k) => s(ix, iy, k) * (1 - fx) * (1 - fy) + s(ix + 1, iy, k) * fx * (1 - fy) + s(ix, iy + 1, k) * (1 - fx) * fy + s(ix + 1, iy + 1, k) * fx * fy;
        let a = bil(3); if (a <= 0.01) continue;
        const q = (y * W + x) * 3;
        if (shadow) { a *= 0.55; for (let k = 0; k < 3; k++) img[q + k] = img[q + k] * (1 - a) + tray.c[k] * 0.45 * a; }
        else { for (let k = 0; k < 3; k++) img[q + k] = img[q + k] * (1 - a) + bil(k) * a; }
      }
  };
  for (const p of pills) blend(p, p.rot, 3, 4, true);
  for (const p of pills) blend(p, p.rot, 0, 0, false);
  // 相機模糊 + 雜訊 → RGBA
  const out = new Uint8ClampedArray(W * H * 4), k = [1, 2, 1], noise = 2 + rng() * 3;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy)); s += img[(yy * W + xx) * 3 + c] * k[dx + 1] * k[dy + 1]; }
      const v = s / 16 + (rng() - 0.5) * 2 * noise; out[(y * W + x) * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    out[(y * W + x) * 4 + 3] = 255;
  }
  return { img: { data: out, width: W, height: H }, truth: pills.length };
}

const SCENES = [{ tag: 'sparse20', count: 20, pTouch: 0 }, { tag: 'touch30', count: 30, pTouch: 0.4 }, { tag: 'dense60', count: 60, pTouch: 0.5 }];
console.log('drug'.padEnd(10), 'scene'.padEnd(9), 'tray'.padEnd(6), 'truth', 'count', 'unc', 'R', 'note');
let seed = 101;
for (const f of files) {
  const name = path.basename(f).replace(/\.bmp$/i, '');
  let cut;
  try { cut = cutout(readBMP(f)); } catch (e) { console.log(name, 'cutout failed:', e.message); continue; }
  // 依藥錠長軸縮放到約 52 px（1000 px 寬畫面上的常見大小）
  const major = Math.max(cut.width, cut.height);
  const target = 44 + (seed % 3) * 8;
  const small = resize(cut, target / major);
  fs.writeFileSync(path.join(outDir, `${name}_cutout.png`), encodePNG(Uint8ClampedArray.from(small.data.map((v, i) => (i % 4 === 3 ? v * 255 : v))), small.width, small.height));
  for (const sc of SCENES) {
    const tray = TRAYS[seed % TRAYS.length];
    const rng = mulberry32(seed++);
    const { img, truth } = compose(small, { count: sc.count, pTouch: sc.pTouch, tray, rng });
    const res = countPills(img);
    const unc = res.pills.filter(p => p.uncertain).length;
    const diff = res.count - truth;
    console.log(name.padEnd(10), sc.tag.padEnd(9), tray.name.padEnd(6), String(truth).padStart(5), String(res.count).padStart(5), String(unc).padStart(3), res.R.toFixed(1).padStart(5), diff === 0 ? 'OK' : (diff > 0 ? `+${diff}` : `${diff}`) + (res.warnings.length ? ' ' + res.warnings.join(',') : ''));
    fs.writeFileSync(path.join(outDir, `${name}_${sc.tag}_t${truth}_c${res.count}.png`), encodePNG(drawMarkers(img, res.pills, res.R).data, img.width, img.height));
    fs.writeFileSync(path.join(outDir, `${name}_${sc.tag}_t${truth}_raw.png`), encodePNG(img.data, img.width, img.height));
  }
}
