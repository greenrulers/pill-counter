// test/synth.mjs — 合成「托盤上的藥錠」測試影像（Node 用，不依賴任何套件）
import zlib from 'node:zlib';

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const rnd = (rng, a, b) => a + rng() * (b - a);

const TRAYS = [
  { name: 'blue', c: [40, 70, 150], light: true },
  { name: 'black', c: [28, 28, 32], light: true },
  { name: 'green', c: [20, 80, 60], light: true },
  { name: 'gray', c: [110, 112, 118], light: true },
  { name: 'white', c: [232, 230, 224], light: false },
];
const LIGHT_PILLS = [[246, 246, 240], [240, 222, 120], [242, 172, 182], [172, 202, 242], [242, 160, 60], [250, 250, 250]];
const DARK_PILLS = [[90, 60, 40], [120, 30, 40], [40, 110, 60], [60, 60, 70]];
const SHAPES = ['disc', 'disc', 'disc', 'oblong', 'capsule', 'scored'];

export function makeScene(rng, o = {}) {
  const W = o.width || 900, H = o.height || 675;
  const tray = o.tray || pick(rng, TRAYS);
  const pTouch = o.pTouch ?? pick(rng, [0, 0, 0.2, 0.5]);
  const r = o.radius || Math.round(rnd(rng, 12, 34));
  const shape = o.shape || pick(rng, SHAPES);
  const palette = tray.light ? LIGHT_PILLS : DARK_PILLS;
  const pillColor = o.pillColor || pick(rng, palette);
  const N = o.count || Math.floor(rnd(rng, 3, 70));
  const specks = o.specks ?? Math.floor(rnd(rng, 0, 6));
  const img = new Float32Array(W * H * 3);

  // 托盤：線性漸層 + 之後加雜訊
  const ang = rnd(rng, 0, Math.PI * 2), gx = Math.cos(ang), gy = Math.sin(ang);
  const gAmp = rnd(rng, 0.05, 0.18);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = ((x / W - 0.5) * gx + (y / H - 0.5) * gy); // -0.7..0.7
    const f = 1 + gAmp * t * 2;
    const p = (y * W + x) * 3;
    img[p] = tray.c[0] * f; img[p + 1] = tray.c[1] * f; img[p + 2] = tray.c[2] * f;
  }

  // 幾何：以等效半徑（外接圓）放置
  const pills = [];
  const effR = shape === 'oblong' ? r * 1.7 : shape === 'capsule' ? r * 1.6 : r;
  const margin = effR + 8;
  let tries = 0;
  while (pills.length < N && tries < 20000) {
    tries++;
    let x, y;
    if (pills.length && rng() < pTouch) {
      const a = pick(rng, pills);
      const th = rnd(rng, 0, Math.PI * 2);
      const d = a.effR + effR - (shape === 'disc' || shape === 'scored' ? 1 : 0);
      x = a.x + Math.cos(th) * d; y = a.y + Math.sin(th) * d;
    } else {
      x = rnd(rng, margin, W - margin); y = rnd(rng, margin, H - margin);
    }
    if (x < margin || y < margin || x > W - margin || y > H - margin) continue;
    let ok = true;
    for (const b of pills) {
      const dd = Math.hypot(b.x - x, b.y - y);
      const minD = b.effR + effR - (shape === 'disc' || shape === 'scored' ? 1 : 0);
      if (dd < minD - 0.01) { ok = false; break; }
      if (dd < minD + 4 && dd > minD + 0.5) { ok = false; break; } // 不要產生「幾乎相碰」的曖昧間隙
    }
    if (!ok) continue;
    pills.push({ x, y, effR, rot: rnd(rng, 0, Math.PI), shape });
  }

  // 繪製：先陰影再藥錠
  const shadowC = tray.c.map(v => v * 0.6);
  for (const p of pills) drawPill(img, W, H, p, r, shadowC, true, rng);
  for (const p of pills) drawPill(img, W, H, p, r, pillColor, false, rng);

  // 雜點
  for (let i = 0; i < specks; i++) {
    const sx = rnd(rng, 10, W - 10), sy = rnd(rng, 10, H - 10), sr = rnd(rng, 1, 3.2);
    fillDisc(img, W, H, sx, sy, sr, pillColor);
  }

  // 相機模糊（3x3 二項）+ 雜訊 → RGBA
  const out = new Uint8ClampedArray(W * H * 4);
  const k = [1, 2, 1];
  const noise = rnd(rng, 2, 6);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy));
        s += img[(yy * W + xx) * 3 + c] * k[dx + 1] * k[dy + 1];
      }
      const v = s / 16 + (rng() - 0.5) * 2 * noise;
      out[(y * W + x) * 4 + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    out[(y * W + x) * 4 + 3] = 255;
  }
  return { img: { data: out, width: W, height: H }, truth: pills.length, meta: { tray: tray.name, shape, r, pTouch, pillColor, N, specks } };
}

function fillDisc(img, W, H, cx, cy, r, col) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(W - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(H - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { const p = (y * W + x) * 3; img[p] = col[0]; img[p + 1] = col[1]; img[p + 2] = col[2]; }
  }
}

function drawPill(img, W, H, p, r, col, shadow, rng) {
  const ox = shadow ? 3 : 0, oy = shadow ? 4 : 0;
  const cx = p.x + ox, cy = p.y + oy;
  const cos = Math.cos(p.rot), sin = Math.sin(p.rot);
  const ext = p.effR + 2;
  const x0 = Math.max(0, Math.floor(cx - ext)), x1 = Math.min(W - 1, Math.ceil(cx + ext));
  const y0 = Math.max(0, Math.floor(cy - ext)), y1 = Math.min(H - 1, Math.ceil(cy + ext));
  const col2 = [col[0] * 0.55 + 80, col[1] * 0.4 + 20, col[2] * 0.4 + 30]; // 膠囊第二色
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = x - cx, dy = y - cy;
    const u = dx * cos + dy * sin, v = -dx * sin + dy * cos; // 旋轉後座標
    let inside = false, f = 1, c = col;
    if (p.shape === 'disc' || p.shape === 'scored') {
      const d2 = u * u + v * v;
      inside = d2 <= r * r;
      if (inside && !shadow) {
        f = 1 - 0.18 * (d2 / (r * r)) ** 2; // 邊緣略暗
        if (p.shape === 'scored' && Math.abs(v) <= 1.2) f *= 0.55; // 刻痕
        if (p.shape === 'disc' && d2 < (r * 0.25) ** 2) f *= 0.9; // 壓印
      }
    } else if (p.shape === 'oblong') {
      const a = r * 1.7, b = r;
      const e = (u * u) / (a * a) + (v * v) / (b * b);
      inside = e <= 1;
      if (inside && !shadow) f = 1 - 0.18 * e * e;
    } else if (p.shape === 'capsule') {
      const L = r * 1.3, hw = r * 0.65; // 全長 3.2r
      const uu = Math.max(-L, Math.min(L, u));
      const d2 = (u - uu) ** 2 + v * v;
      inside = d2 <= hw * hw;
      if (inside && !shadow) { f = 1 - 0.2 * (v * v) / (hw * hw); if (u > 0) c = col2; }
    }
    if (!inside) continue;
    const q = (y * W + x) * 3;
    if (shadow) { img[q] = img[q] * 0.5 + c[0] * 0.5; img[q + 1] = img[q + 1] * 0.5 + c[1] * 0.5; img[q + 2] = img[q + 2] * 0.5 + c[2] * 0.5; }
    else { img[q] = c[0] * f; img[q + 1] = c[1] * f; img[q + 2] = c[2] * f; }
  }
}

// ---- PNG 輸出（RGBA → PNG，用 zlib） ----
export function encodePNG(data, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(tb) >>> 0);
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 在影像上畫標記（圓圈 + 不確定者改色）供目視檢查
export function drawMarkers(img, pills, R) {
  const { data, width: W, height: H } = img;
  const out = new Uint8ClampedArray(data);
  for (const p of pills) {
    const col = p.uncertain ? [255, 140, 0] : [0, 255, 80];
    const rr = Math.max(4, R * 0.5);
    for (let t = 0; t < 360; t += 2) {
      const a = t * Math.PI / 180;
      for (let k = -1; k <= 1; k++) {
        const x = Math.round(p.x + Math.cos(a) * (rr + k * 0.5)), y = Math.round(p.y + Math.sin(a) * (rr + k * 0.5));
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const q = (y * W + x) * 4; out[q] = col[0]; out[q + 1] = col[1]; out[q + 2] = col[2];
      }
    }
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = Math.round(p.x) + dx, y = Math.round(p.y) + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const q = (y * W + x) * 4; out[q] = 255; out[q + 1] = 0; out[q + 2] = 0;
    }
  }
  return { data: out, width: W, height: H };
}
