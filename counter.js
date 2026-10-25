// counter.js — 藥錠計數演算法（純 JavaScript，瀏覽器與 Node 共用，不依賴 DOM）
//
// 流程：
//   1. 估計背景（托盤）顏色：全域取外框帶狀區域的眾數色，再分區（格狀）修正光線漸層
//      → 每個像素算「與局部背景的顏色距離」當作特徵圖 D
//   2. 平滑 → 門檻：以外框雜訊水準為下限，取「雜訊水準到最亮物體之間的某個比例」（對藥量多寡不敏感）
//   3. 形態學（閉運算補刻痕、開運算去雜點），半徑依藥錠大小自動調整
//   4. 精確歐氏距離轉換（EDT）×2：未填洞版找波峰（保留藥錠間的小空隙），填洞版做頸部測試與面積
//   5. 每個連通元件用 EDT 波峰 + 非極大抑制 + 「頸部測試」拆分相連藥錠（圓錠會拆、長錠／膠囊不會被誤拆）
//   6. 以「每顆面積中位數」過濾雜點、標記不確定的元件
//
// 輸入：{ data: Uint8ClampedArray(RGBA), width, height }
// 輸出：{ count, pills:[{x,y,r,uncertain,...}], mask, R, A1, threshold, warnings, ... }

export const DEFAULTS = {
  sensitivity: 0,     // -50..50（%）。正值 = 門檻更高、只抓對比更強的區域
  polarity: 'auto',   // 'auto'（顏色距離）| 'light'（藥比底亮）| 'dark'（藥比底暗）
  split: true,        // 是否拆分相連藥錠
  minAreaRatio: 0.3,  // 面積小於「單顆中位面積 × 此值」者視為雜點
  blur: 1,            // 平滑半徑（像素）
  neck: 0.75,         // 頸部測試：兩波峰間最小 EDT ≥ neck × 較小波峰 → 視為同一顆
  nms: 0.6,           // 波峰非極大抑制半徑 = nms × R
  peakMin: 0.35,      // 波峰最小 EDT = peakMin × R
  rQuantile: 0.8,     // 藥錠半徑估計用的分位數
  closeFactor: 0.08,  // 閉運算半徑 = closeFactor × R（補刻痕）
  threshold: 'otsu',  // 'otsu'（限制在雜訊水準以上的 Otsu，預設）| 'pct'（雜訊水準→最亮物體的比例）
  pctLevel: 0.4,      // threshold='pct' 時的比例
  localBg: true,      // 分區背景修正
  tiles: 8,           // 分區數（長邊）
};

const INF = 1e12;

export function countPills(img, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const w = img.width, h = img.height, n = w * h;
  const data = img.data;
  const warnings = [];

  // ---- 1. 背景與特徵圖 ----
  const bg = estimateBackground(data, w, h);
  const feat = featureMap(data, w, h, bg, opt);

  // ---- 2. 平滑 + 門檻 ----
  const sm = opt.blur > 0 ? boxBlur(feat, w, h, opt.blur) : feat;
  const hist = histogram(sm);
  const noise = noiseLevel(hist);
  const Tmin = Math.max(14, noise + 6);
  const hi = percentile(hist, n, 0.995);
  let T;
  if (opt.threshold === 'otsu') {
    T = otsuThreshold(sm, Tmin).t * (1 + opt.sensitivity / 100);
  } else {
    const level = clamp(opt.pctLevel * (1 + opt.sensitivity / 100), 0.1, 0.9);
    T = Tmin + level * Math.max(0, hi - Tmin);
  }
  if (T < Tmin + 6) T = Tmin + 6;
  if (hi - Tmin < 25) warnings.push('low_contrast');
  let mask = thresholdMask(sm, T);
  let fg = 0;
  for (let i = 0; i < n; i++) fg += mask[i];
  const fgFrac = fg / n;
  if (fgFrac < 0.002) warnings.push('no_foreground');
  if (fgFrac > 0.6) warnings.push('too_much_foreground');

  // ---- 3. 第一輪形態學（半徑 1）→ 估計藥錠半徑 R ----
  mask = openMask(closeMask(mask, w, h, 1), w, h, 1);
  let dtU = edt(mask, w, h);
  let comps = labelComponents(mask, w, h, dtU);
  let R = estimateRadius(comps, opt.rQuantile);

  // ---- 4. 第二輪：依 R 調整形態學半徑 ----
  if (R >= 6) {
    const rc = clamp(Math.round(R * opt.closeFactor), 1, 3);
    const ro = clamp(Math.round(R * 0.10), 1, 4);
    mask = thresholdMask(sm, T);
    mask = openMask(closeMask(mask, w, h, rc), w, h, ro);
    dtU = edt(mask, w, h);
  }
  const maskF = fillHolesCopy(mask, w, h);
  const dtF = edt(maskF, w, h);
  comps = labelComponents(maskF, w, h, dtU); // 連通用填洞版；maxDt 用未填洞版（洞內 dtU=0）
  R = estimateRadius(comps, opt.rQuantile);

  // ---- 5. 拆分相連藥錠 ----
  const results = [];
  for (const c of comps) {
    if (c.area < 12) continue;
    let centers = [];
    if (opt.split && R >= 4) centers = splitComponent(c, comps.labels, dtU, dtF, w, h, R, opt);
    if (centers.length === 0) centers = [{ x: c.mx, y: c.my, d: Math.sqrt(c.maxDt) }];
    results.push({ comp: c, centers });
  }

  // ---- 5b. 合併被深刻痕切成兩半的錠：兩個單中心、相鄰、合起來很圓的元件 ----
  if (opt.split) mergeHalves(results);

  // ---- 6. 單顆面積中位數 → 雜點過濾、不確定標記 ----
  const perPill = results.map(r => r.comp.area / r.centers.length).sort((a, b) => a - b);
  const A1 = perPill.length ? perPill[Math.floor(perPill.length / 2)] : 0;
  const pills = [];
  let specks = 0;
  for (const r of results) {
    const c = r.comp;
    const ratio = A1 > 0 ? c.area / A1 : 1;
    if (ratio < opt.minAreaRatio) { specks++; continue; }
    const edge = c.x0 === 0 || c.y0 === 0 || c.x1 === w - 1 || c.y1 === h - 1;
    const nC = r.centers.length;
    const uncertain = edge || Math.abs(nC - ratio) > 0.45;
    for (const ct of r.centers) {
      pills.push({ x: ct.x, y: ct.y, r: R, comp: c.id, uncertain, areaRatio: ratio, n: nC, edge });
    }
  }

  return {
    count: pills.length, pills, R, A1, threshold: T, tmin: Tmin, hi, bg, fgFrac,
    warnings, mask: maskF, width: w, height: h, specks, components: comps.length,
  };
}

// ---------- 全域背景估計：影像外框帶狀區域中最常見的顏色 ----------
export function estimateBackground(data, w, h) {
  const bw = Math.max(2, Math.round(w * 0.06)), bh = Math.max(2, Math.round(h * 0.06));
  const hist = new Uint32Array(32768); // 5 bits / channel
  const each = (fn) => {
    for (let y = 0; y < h; y++) {
      if (y < bh || y >= h - bh) { for (let x = 0; x < w; x++) fn(x, y); }
      else { for (let x = 0; x < bw; x++) { fn(x, y); fn(w - 1 - x, y); } }
    }
  };
  each((x, y) => { const p = (y * w + x) * 4; hist[((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3)]++; });
  let best = 0, bestC = 0;
  for (let i = 0; i < 32768; i++) if (hist[i] > bestC) { bestC = hist[i]; best = i; }
  const br = best >> 10, bgi = (best >> 5) & 31, bb = best & 31;
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  each((x, y) => {
    const p = (y * w + x) * 4;
    if (Math.abs((data[p] >> 3) - br) <= 1 && Math.abs((data[p + 1] >> 3) - bgi) <= 1 && Math.abs((data[p + 2] >> 3) - bb) <= 1) {
      sr += data[p]; sg += data[p + 1]; sb += data[p + 2]; cnt++;
    }
  });
  if (cnt === 0) { sr = (br << 3) + 4; sg = (bgi << 3) + 4; sb = (bb << 3) + 4; cnt = 1; }
  const r = sr / cnt, g = sg / cnt, b = sb / cnt;
  return { r, g, b, l: 0.299 * r + 0.587 * g + 0.114 * b };
}

// ---------- 分區背景圖：每格取「接近全域背景色」像素的眾數色，缺格由鄰格補、再平滑 ----------
function backgroundMap(data, w, h, gbg, tilesLong) {
  const TX = w >= h ? tilesLong : Math.max(3, Math.round(tilesLong * w / h));
  const TY = w >= h ? Math.max(3, Math.round(tilesLong * h / w)) : tilesLong;
  const tw = w / TX, th = h / TY;
  const cols = new Float32Array(TX * TY * 3), ok = new Uint8Array(TX * TY);
  const hist = new Uint32Array(32768);
  const near2 = 100 * 100;
  for (let j = 0; j < TY; j++) for (let i = 0; i < TX; i++) {
    const x0 = Math.floor(i * tw), x1 = Math.min(w, Math.floor((i + 1) * tw));
    const y0 = Math.floor(j * th), y1 = Math.min(h, Math.floor((j + 1) * th));
    hist.fill(0);
    let total = 0, near = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const p = (y * w + x) * 4;
      const dr = data[p] - gbg.r, dg = data[p + 1] - gbg.g, db = data[p + 2] - gbg.b;
      total++;
      if (dr * dr + dg * dg + db * db < near2) { near++; hist[((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3)]++; }
    }
    if (near < total * 0.05) continue;
    let best = 0, bestC = 0;
    for (let k = 0; k < 32768; k++) if (hist[k] > bestC) { bestC = hist[k]; best = k; }
    const br = best >> 10, bgi = (best >> 5) & 31, bb = best & 31;
    let sr = 0, sg = 0, sb = 0, cnt = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const p = (y * w + x) * 4;
      if (Math.abs((data[p] >> 3) - br) <= 1 && Math.abs((data[p + 1] >> 3) - bgi) <= 1 && Math.abs((data[p + 2] >> 3) - bb) <= 1) {
        sr += data[p]; sg += data[p + 1]; sb += data[p + 2]; cnt++;
      }
    }
    if (!cnt) continue;
    const t = (j * TX + i) * 3;
    cols[t] = sr / cnt; cols[t + 1] = sg / cnt; cols[t + 2] = sb / cnt; ok[j * TX + i] = 1;
  }
  // 缺格補值
  let anyOk = false;
  for (let k = 0; k < TX * TY; k++) if (ok[k]) { anyOk = true; break; }
  if (!anyOk) { for (let k = 0; k < TX * TY; k++) { cols[k * 3] = gbg.r; cols[k * 3 + 1] = gbg.g; cols[k * 3 + 2] = gbg.b; } }
  else {
    for (let iter = 0; iter < TX + TY; iter++) {
      let missing = 0;
      const nextOk = Uint8Array.from(ok);
      for (let j = 0; j < TY; j++) for (let i = 0; i < TX; i++) {
        const k = j * TX + i;
        if (ok[k]) continue;
        let sr = 0, sg = 0, sb = 0, c = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= TX || jj >= TY) continue;
          const kk = jj * TX + ii;
          if (ok[kk]) { sr += cols[kk * 3]; sg += cols[kk * 3 + 1]; sb += cols[kk * 3 + 2]; c++; }
        }
        if (c) { cols[k * 3] = sr / c; cols[k * 3 + 1] = sg / c; cols[k * 3 + 2] = sb / c; nextOk[k] = 1; }
        else missing++;
      }
      ok.set(nextOk);
      if (!missing) break;
    }
  }
  // 3x3 平滑
  const sm = new Float32Array(cols.length);
  for (let j = 0; j < TY; j++) for (let i = 0; i < TX; i++) {
    let sr = 0, sg = 0, sb = 0, c = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= TX || jj >= TY) continue;
      const kk = (jj * TX + ii) * 3; sr += cols[kk]; sg += cols[kk + 1]; sb += cols[kk + 2]; c++;
    }
    const k = (j * TX + i) * 3; sm[k] = sr / c; sm[k + 1] = sg / c; sm[k + 2] = sb / c;
  }
  return { TX, TY, tw, th, cols: sm };
}

// ---------- 特徵圖 D：與（局部）背景的顏色距離，或亮度差 ----------
function featureMap(data, w, h, gbg, opt) {
  const n = w * h, feat = new Uint8Array(n);
  if (opt.polarity !== 'auto') {
    const sign = opt.polarity === 'light' ? 1 : -1;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const L = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
      const d = sign * (L - gbg.l) * 1.5;
      feat[i] = d < 0 ? 0 : d > 255 ? 255 : d;
    }
    return feat;
  }
  if (!opt.localBg) {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const dr = data[p] - gbg.r, dg = data[p + 1] - gbg.g, db = data[p + 2] - gbg.b;
      const d = Math.sqrt(dr * dr + dg * dg + db * db);
      feat[i] = d > 255 ? 255 : d;
    }
    return feat;
  }
  const m = backgroundMap(data, w, h, gbg, opt.tiles);
  const { TX, TY, tw, th, cols } = m;
  const rowBg = new Float32Array(w * 3);
  for (let y = 0; y < h; y++) {
    let v = y / th - 0.5; let j0 = Math.floor(v); let fy = v - j0;
    if (j0 < 0) { j0 = 0; fy = 0; } if (j0 >= TY - 1) { j0 = TY - 1; fy = 0; }
    const j1 = Math.min(TY - 1, j0 + 1);
    for (let x = 0; x < w; x++) {
      let u = x / tw - 0.5; let i0 = Math.floor(u); let fx = u - i0;
      if (i0 < 0) { i0 = 0; fx = 0; } if (i0 >= TX - 1) { i0 = TX - 1; fx = 0; }
      const i1 = Math.min(TX - 1, i0 + 1);
      const a = (j0 * TX + i0) * 3, b = (j0 * TX + i1) * 3, c = (j1 * TX + i0) * 3, d = (j1 * TX + i1) * 3;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      rowBg[x * 3] = cols[a] * w00 + cols[b] * w10 + cols[c] * w01 + cols[d] * w11;
      rowBg[x * 3 + 1] = cols[a + 1] * w00 + cols[b + 1] * w10 + cols[c + 1] * w01 + cols[d + 1] * w11;
      rowBg[x * 3 + 2] = cols[a + 2] * w00 + cols[b + 2] * w10 + cols[c + 2] * w01 + cols[d + 2] * w11;
    }
    for (let x = 0, i = y * w, p = i * 4; x < w; x++, i++, p += 4) {
      const dr = data[p] - rowBg[x * 3], dg = data[p + 1] - rowBg[x * 3 + 1], db = data[p + 2] - rowBg[x * 3 + 2];
      const dd = Math.sqrt(dr * dr + dg * dg + db * db);
      feat[i] = dd > 255 ? 255 : dd;
    }
  }
  return feat;
}

// ---------- 直方圖 / 百分位 ----------
function histogram(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  return hist;
}
function percentile(hist, total, q) {
  let acc = 0; const target = total * q;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
  return 255;
}
// 背景雜訊水準：特徵圖直方圖在低值區的背景峰，往右走到第一個低於峰值 3% 的 bin
function noiseLevel(hist) {
  let m0 = 0, pk = 0;
  for (let i = 0; i <= 80; i++) if (hist[i] > pk) { pk = hist[i]; m0 = i; }
  let e = m0;
  for (let i = m0 + 1; i < 256; i++) { e = i; if (hist[i] < pk * 0.03) break; }
  return e;
}
function borderPercentile(gray, w, h, q) {
  const bw = Math.max(2, Math.round(w * 0.06)), bh = Math.max(2, Math.round(h * 0.06));
  const hist = new Uint32Array(256); let total = 0;
  for (let y = 0; y < h; y++) {
    if (y < bh || y >= h - bh) { for (let x = 0; x < w; x++) { hist[gray[y * w + x]]++; total++; } }
    else { for (let x = 0; x < bw; x++) { hist[gray[y * w + x]]++; hist[gray[y * w + w - 1 - x]]++; total += 2; } }
  }
  return percentile(hist, total, q);
}

// ---------- 盒狀平滑（可分離） ----------
export function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Uint8Array(w * h);
  const k = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / k;
      s += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.round(s / k);
      s += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

// ---------- Otsu 門檻（可限制門檻下限） ----------
export function otsuThreshold(gray, tmin = 0) {
  const hist = histogram(gray);
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, t = tmin;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (wB === 0) continue;
    const wF = total - wB; if (wF === 0) break;
    sumB += i * hist[i];
    if (i < tmin) continue;
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; t = i; }
  }
  return { t, variance: best };
}

export function thresholdMask(gray, T) {
  const m = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) m[i] = gray[i] > T ? 1 : 0;
  return m;
}

// ---------- 形態學（圓形結構元素） ----------
function discOffsets(r) {
  const o = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r * 0.5) o.push([dx, dy]);
  return o;
}
export function dilate(mask, w, h, r) {
  const out = new Uint8Array(w * h), off = discOffsets(r);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    for (const [dx, dy] of off) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
    }
  }
  return out;
}
export function erode(mask, w, h, r) {
  const out = new Uint8Array(w * h), off = discOffsets(r);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    let ok = 1;
    for (const [dx, dy] of off) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || !mask[yy * w + xx]) { ok = 0; break; }
    }
    out[y * w + x] = ok;
  }
  return out;
}
export const closeMask = (m, w, h, r) => erode(dilate(m, w, h, r), w, h, r);
export const openMask = (m, w, h, r) => dilate(erode(m, w, h, r), w, h, r);

// ---------- 填洞（回傳新遮罩）：從邊界 BFS 背景，到不了的背景即為洞 ----------
export function fillHolesCopy(mask, w, h) {
  const n = w * h, out = Uint8Array.from(mask), seen = new Uint8Array(n), q = new Int32Array(n);
  let qh = 0, qt = 0;
  const seed = i => { if (!mask[i] && !seen[i]) { seen[i] = 1; q[qt++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (qh < qt) {
    const i = q[qh++], x = i % w, y = (i - x) / w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (y > 0) seed(i - w);
    if (y < h - 1) seed(i + w);
  }
  for (let i = 0; i < n; i++) if (!mask[i] && !seen[i]) out[i] = 1;
  return out;
}

// ---------- 精確歐氏距離轉換（Felzenszwalb & Huttenlocher），回傳「平方距離」；影像外視為背景 ----------
export function edt(mask, w, h) {
  const W = w + 2, H = h + 2;
  const f = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inside = x > 0 && y > 0 && x < W - 1 && y < H - 1 && mask[(y - 1) * w + (x - 1)];
    f[y * W + x] = inside ? INF : 0;
  }
  const maxN = Math.max(W, H);
  const col = new Float64Array(maxN), dcol = new Float64Array(maxN);
  const v = new Int32Array(maxN), z = new Float64Array(maxN + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) col[y] = f[y * W + x];
    dt1d(col, H, dcol, v, z);
    for (let y = 0; y < H; y++) f[y * W + x] = dcol[y];
  }
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) col[x] = f[row + x];
    dt1d(col, W, dcol, v, z);
    for (let x = 0; x < W; x++) f[row + x] = dcol[x];
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = f[(y + 1) * W + (x + 1)];
  return out;
}
function dt1d(f, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// ---------- 連通元件（8 連通），附統計 ----------
export function labelComponents(mask, w, h, dt) {
  const n = w * h, labels = new Int32Array(n), q = new Int32Array(n);
  const comps = [];
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || labels[s]) continue;
    id++;
    let qh = 0, qt = 0;
    labels[s] = id; q[qt++] = s;
    const c = { id, area: 0, sx: 0, sy: 0, x0: w, y0: h, x1: 0, y1: 0, maxDt: 0, mx: 0, my: 0 };
    while (qh < qt) {
      const i = q[qh++], x = i % w, y = (i - x) / w;
      c.area++; c.sx += x; c.sy += y;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      if (dt && dt[i] > c.maxDt) { c.maxDt = dt[i]; c.mx = x; c.my = y; }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && !labels[j]) { labels[j] = id; q[qt++] = j; }
        }
      }
    }
    c.cx = c.sx / c.area; c.cy = c.sy / c.area;
    if (!c.maxDt) { c.mx = c.cx; c.my = c.cy; }
    comps.push(c);
  }
  comps.labels = labels;
  return comps;
}

// ---------- 藥錠半徑估計：各元件最大 EDT（內切圓半徑）的高分位數 ----------
// 內切圓半徑不會因相連而變大，但碎片、半錠、被刻痕切開的錠會把它拉低，所以取高分位數
function estimateRadius(comps, q = 0.8) {
  const rs = comps.filter(c => c.area >= 20).map(c => Math.sqrt(c.maxDt)).sort((a, b) => a - b);
  if (!rs.length) return 0;
  return rs[Math.min(rs.length - 1, Math.floor(rs.length * q))];
}

// ---------- 拆分相連藥錠：EDT 波峰 → 非極大抑制 → 頸部測試 ----------
function splitComponent(c, labels, dtU, dtF, w, h, R, opt) {
  const id = c.id;
  const minDt = (opt.peakMin * R) ** 2;
  const cand = [];
  for (let y = c.y0; y <= c.y1; y++) {
    for (let x = c.x0; x <= c.x1; x++) {
      const i = y * w + x;
      if (labels[i] !== id) continue;
      const v = dtU[i];
      if (v < minDt) continue;
      let isMax = true;
      for (let dy = -1; dy <= 1 && isMax; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          if (dtU[yy * w + xx] > v) { isMax = false; break; }
        }
      }
      if (isMax) cand.push({ x, y, v, vf: dtF[i] });
    }
  }
  if (cand.length === 0) return [];
  cand.sort((a, b) => b.v - a.v);
  const nms2 = (opt.nms * R) ** 2;
  const kept = [];
  outer: for (const p of cand) {
    for (const k of kept) {
      const dx = p.x - k.x, dy = p.y - k.y;
      if (dx * dx + dy * dy < nms2) continue outer;              // 太近 → 同一顆
      if (!hasNeck(p, k, dtF, w, opt.neck)) continue outer;     // 中間沒有變窄 → 同一顆（長錠／膠囊／有壓印的錠）
    }
    kept.push(p);
  }
  // 面積上限：一個元件最多能裝幾顆「內切圓半徑 R」的藥（避免刻痕錠被拆成兩顆）
  const nMax = Math.max(1, Math.floor(c.area / (0.6 * Math.PI * R * R)));
  if (kept.length > nMax) kept.length = nMax;
  return kept.map(p => ({ x: p.x, y: p.y, d: Math.sqrt(p.v) }));
}

// 兩個單中心元件：質心距離 ≤ 1.2×等效半徑，且聯集的外接方框圓滿度 ≥ 0.8 → 視為同一顆被切開的錠
function mergeHalves(results) {
  const singles = results.filter(r => r.centers.length === 1);
  for (let i = 0; i < singles.length; i++) {
    const a = singles[i]; if (a.dead || a.merged) continue;
    for (let j = i + 1; j < singles.length; j++) {
      const b = singles[j]; if (b.dead || b.merged) continue;
      const ca = a.comp, cb = b.comp;
      const sumA = ca.area + cb.area;
      const rEq = Math.sqrt(sumA / Math.PI);
      const dx = ca.cx - cb.cx, dy = ca.cy - cb.cy;
      if (dx * dx + dy * dy > (1.2 * rEq) ** 2) continue;
      const x0 = Math.min(ca.x0, cb.x0), x1 = Math.max(ca.x1, cb.x1), y0 = Math.min(ca.y0, cb.y0), y1 = Math.max(ca.y1, cb.y1);
      const diam = Math.max(x1 - x0 + 1, y1 - y0 + 1);
      const compact = sumA / (Math.PI * (diam / 2) ** 2);
      if (compact < 0.8) continue;
      a.comp = { ...ca, area: sumA, x0, x1, y0, y1, cx: (ca.cx * ca.area + cb.cx * cb.area) / sumA, cy: (ca.cy * ca.area + cb.cy * cb.area) / sumA, maxDt: Math.max(ca.maxDt, cb.maxDt) };
      a.centers = [{ x: (x0 + x1) / 2, y: (y0 + y1) / 2, d: diam / 2 }];
      a.merged = true; b.dead = true;
      break;
    }
  }
  for (let k = results.length - 1; k >= 0; k--) if (results[k].dead) results.splice(k, 1);
}

// 兩波峰連線上的最小 EDT（填洞版）是否明顯小於較小波峰（有「頸部」→ 兩顆）
function hasNeck(a, b, dt, w, neck) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const steps = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy)));
  let m = Infinity;
  for (let t = 1; t < steps; t++) {
    const x = Math.round(a.x + dx * t / steps), y = Math.round(a.y + dy * t / steps);
    const v = dt[y * w + x];
    if (v < m) m = v;
  }
  if (m === Infinity) return false;
  const small = Math.min(a.vf, b.vf);
  return Math.sqrt(m) < neck * Math.sqrt(small);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
