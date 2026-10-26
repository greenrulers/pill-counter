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
  otsu3: true,        // 是否嘗試三類 Otsu（藥的顏色介於托盤與更亮物體之間時用；測試用開關）
  circles: true,      // 分割結果不可靠時，是否改用圓形偵測（中心點法）備援
  tiles: 8,           // 分區數（長邊）
};

import { detectCircles } from './blobs.js';

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
  let T, tmode = opt.threshold, o3 = null;
  if (opt.threshold === 'otsu') {
    T = otsuThreshold(sm, Tmin, hist).t;
    // 三類 Otsu 候選：藥的顏色介於托盤與另一種更亮的物體之間時（例如紅藥＋藍藥在木紋上），
    // 兩類 Otsu 會把門檻放在中間那類藥身上。候選要再通過下面的「形狀守門」才採用。
    const c3 = otsu3(hist, n, Tmin);
    if (opt.otsu3 && c3 && c3.t1 >= Tmin && c3.midFrac >= 0.03 && c3.t1 < T - 8) o3 = { ...c3, o2: T };
    T *= (1 + opt.sensitivity / 100);
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
  const minArea = Math.max(20, Math.round(n * 0.0003)); // 半徑估計只看夠大的元件，免得數百個雜點把 R 拉成個位數
  let R = estimateRadius(comps, opt.rQuantile, minArea);

  // ---- 3b. 三類 Otsu 的形狀守門：中間類像素單獨做開運算，薄月牙（陰影）會消失、藥會留下 ----
  if (o3 && R >= 6) {
    const t1 = o3.t1 * (1 + opt.sensitivity / 100);
    const mid = new Uint8Array(n);
    let midA = 0;
    for (let i = 0; i < n; i++) if (sm[i] > t1 && sm[i] <= T) { mid[i] = 1; midA++; }
    const ro3 = clamp(Math.round(R * 0.25), 2, 6);
    const kept = openMask(mid, w, h, ro3);
    let keptA = 0;
    for (let i = 0; i < n; i++) keptA += kept[i];
    const survive = midA ? keptA / midA : 0;
    if (survive >= 0.5) {
      T = t1; tmode = 'otsu3';
      mask = thresholdMask(sm, T);
      mask = openMask(closeMask(mask, w, h, 1), w, h, 1);
      dtU = edt(mask, w, h);
      comps = labelComponents(mask, w, h, dtU);
      R = estimateRadius(comps, opt.rQuantile, minArea);
    }
    o3.survive = survive;
  }

  // ---- 4. 第二輪：依 R 調整形態學半徑 ----
  if (R >= 6) {
    const rc = clamp(Math.round(R * opt.closeFactor), 1, 3);
    const ro = clamp(Math.round(R * 0.10), 1, 4);
    mask = thresholdMask(sm, T);
    mask = openMask(closeMask(mask, w, h, rc), w, h, ro);
    dtU = edt(mask, w, h);
  }
  // 只填比「一顆藥」小的洞（刻痕、相連藥之間的縫）；袋子外框／格線圍出的大洞不填
  const maskF = fillHolesCopy(mask, w, h, R >= 4 ? Math.PI * R * R : Infinity);
  const dtF = edt(maskF, w, h);
  comps = labelComponents(maskF, w, h, dtU); // 連通用填洞版；maxDt 用未填洞版（洞內 dtU=0）
  R = estimateRadius(comps, opt.rQuantile, minArea);

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
  // 尺寸分布：用每顆中心的內切圓半徑（群聚裡的每一顆都有自己的值），四分位距／中位數 > 0.35 視為「大小不一」，
  // 放寬不確定判定（否則混裝時全部橘色）
  const radii = results.flatMap(r => r.centers.map(ct => ct.d || 0)).filter(d => d > 0).sort((a, b) => a - b);
  const rq1 = radii[Math.floor(radii.length * 0.25)] || 0, rq2 = radii[Math.floor(radii.length * 0.5)] || 0, rq3 = radii[Math.floor(radii.length * 0.75)] || 0;
  const mixed = rq2 > 0 && (rq3 - rq1) / rq2 > 0.35;
  const uncTol = mixed ? 1.2 : 0.45;
  const pills = [];
  let specks = 0, lines = 0;
  for (const r of results) {
    const c = r.comp;
    const ratio = A1 > 0 ? c.area / A1 : 1;
    if (ratio < opt.minAreaRatio) { specks++; continue; }
    const edge = c.x0 === 0 || c.y0 === 0 || c.x1 === w - 1 || c.y1 === h - 1;
    const nC = r.centers.length;
    // 細長條過濾：夾鏈袋邊緣、封口線、皺褶反光、托盤格線 —— 內切圓很小（比藥細很多）、外框很長、
    // 面積遠大於「顆數 × 內切圓面積」。一排相連的圓錠內切圓 ≈ R，不會被誤刪；膠囊外框比 ≈ 3、fill ≈ 2，也不會
    const dC = Math.sqrt(c.maxDt);
    const bw = c.x1 - c.x0 + 1, bh = c.y1 - c.y0 + 1;
    const elong = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh));
    const fill = c.area / Math.max(1, nC * Math.PI * dC * dC);
    // 外框很長的細線（袋邊、封口線、皺褶）；或任何形狀的「網／環」（整圈袋子外框、托盤格線）：內切圓遠小於藥、面積卻是它的幾十倍
    if (R > 0 && ((dC < 0.6 * R && elong > 3 && fill > 4) || fill > 12)) { lines++; continue; }
    const uncertain = edge || Math.abs(nC - ratio) > uncTol * Math.max(1, nC * 0.5);
    for (const ct of r.centers) {
      pills.push({ x: ct.x, y: ct.y, r: R, comp: c.id, uncertain, areaRatio: ratio, n: nC, edge });
    }
  }

  // 背景雜亂（袋子、反光、格線）：被當成細長條略過的元件很多 → 提醒使用者換單色托盤或靠近拍
  if (lines >= 3 && lines * 3 >= pills.length) warnings.push('clutter');
  const uncN = pills.reduce((a, p) => a + (p.uncertain ? 1 : 0), 0);
  if (pills.length >= 6 && uncN * 2 > pills.length) warnings.push('mostly_uncertain');

  // ---- 7. 備援：分割結果不可靠時改用圓形偵測（中心點法） ----
  // 不可靠的訊號：橘色 ≥ 30%、背景雜亂、被略過的線條很多、或元件大到像整個袋子／托盤（R ≥ 短邊 20%）
  let circles = null;
  const uncFrac = pills.length ? uncN / pills.length : 0;
  // 另外：對比太低、估出的藥錠半徑小到不合理（< 6 px，白藥配白袋時分割只抓到幾個亮點）、或只找到 ≤ 2 顆，也交給圓形偵測確認
  const distressed = warnings.includes('clutter') || warnings.includes('mostly_uncertain') || warnings.includes('low_contrast') ||
    uncFrac >= 0.3 || R >= 0.2 * Math.min(w, h) || R < 6 || pills.length <= 2;
  if (opt.circles && distressed) {
    circles = detectCircles(img, {});
    // 採用條件：至少 3 個圓、八成以上是整圈都有邊緣的「強圓」、半徑不在偵測下限附近（小而密的錠圓形偵測會多抓）
    if (circles.pills.length >= 3 && circles.quality >= 0.8 && circles.R >= 12) {
      pills.length = 0;
      for (const c of circles.pills) pills.push({ x: c.x, y: c.y, r: circles.R, comp: 0, uncertain: c.uncertain, areaRatio: 1, n: 1, edge: false, circle: true, support: c.support });
      R = circles.R; tmode = 'circles';
      warnings.push('circle_mode');
    }
  }

  return {
    count: pills.length, pills, R, A1, mixed, threshold: T, tmode, tmin: Tmin, hi, bg, fgFrac,
    warnings, mask: maskF, width: w, height: h, specks, lines, components: comps.length, o3, comps,
    circles: circles ? { count: circles.pills.length, R: circles.R, quality: circles.quality, candidates: circles.candidates } : null,
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
  // 「像背景」的判定：RGB 距離 < 60，或色度（r,g 佔比）相近且亮度在 0.5–1.6 倍之間
  // → 容忍托盤的明暗漸層（同色度、不同亮度），但不把顏色不同的深色藥（例如紅棕木紋上的暗紅藥）當成背景
  const near2 = 60 * 60;
  const gsum = Math.max(1, gbg.r + gbg.g + gbg.b), gcr = gbg.r / gsum, gcg = gbg.g / gsum;
  const isBgLike = (r, g, b) => {
    const dr = r - gbg.r, dg = g - gbg.g, db = b - gbg.b;
    if (dr * dr + dg * dg + db * db < near2) return true;
    const sum = r + g + b;
    if (sum < 30) return false;
    const ratio = sum / gsum;
    if (ratio < 0.5 || ratio > 1.6) return false;
    const dcr = r / sum - gcr, dcg = g / sum - gcg;
    return dcr * dcr + dcg * dcg < 0.04 * 0.04;
  };
  for (let j = 0; j < TY; j++) for (let i = 0; i < TX; i++) {
    const x0 = Math.floor(i * tw), x1 = Math.min(w, Math.floor((i + 1) * tw));
    const y0 = Math.floor(j * th), y1 = Math.min(h, Math.floor((j + 1) * th));
    hist.fill(0);
    let total = 0, near = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const p = (y * w + x) * 4;
      total++;
      if (isBgLike(data[p], data[p + 1], data[p + 2])) { near++; hist[((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3)]++; }
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
    const mr = sr / cnt, mg = sg / cnt, mb = sb / cnt;
    if (!isBgLike(mr, mg, mb)) continue; // 格內眾數色不像背景 → 視為缺格
    const t = (j * TX + i) * 3;
    cols[t] = mr; cols[t + 1] = mg; cols[t + 2] = mb; ok[j * TX + i] = 1;
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
export function featureMap(data, w, h, gbg, opt) {
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
  // 每一欄的格索引與權重只跟 x 有關，先算好
  const ci0 = new Int32Array(w), ci1 = new Int32Array(w), cfx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let u = x / tw - 0.5; let i0 = Math.floor(u); let fx = u - i0;
    if (i0 < 0) { i0 = 0; fx = 0; } if (i0 >= TX - 1) { i0 = TX - 1; fx = 0; }
    ci0[x] = i0 * 3; ci1[x] = Math.min(TX - 1, i0 + 1) * 3; cfx[x] = fx;
  }
  const rowBg = new Float32Array(w * 3);
  for (let y = 0; y < h; y++) {
    let v = y / th - 0.5; let j0 = Math.floor(v); let fy = v - j0;
    if (j0 < 0) { j0 = 0; fy = 0; } if (j0 >= TY - 1) { j0 = TY - 1; fy = 0; }
    const j1 = Math.min(TY - 1, j0 + 1);
    const r0 = j0 * TX * 3, r1 = j1 * TX * 3;
    for (let x = 0; x < w; x++) {
      const fx = cfx[x];
      const a = r0 + ci0[x], b = r0 + ci1[x], c = r1 + ci0[x], d = r1 + ci1[x];
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
// 背景雜訊水準：特徵圖直方圖在低值區的背景峰，取右側半高寬 × 3（約 3.5σ），並設上限
// （不能用「走到谷底」：木紋等有紋理的背景或藥很多時沒有明顯谷底，會一路走進藥的亮度區）
function noiseLevel(hist) {
  let m0 = 0, pk = 0;
  for (let i = 0; i <= 80; i++) if (hist[i] > pk) { pk = hist[i]; m0 = i; }
  let e = m0;
  for (let i = m0 + 1; i < 256; i++) { e = i; if (hist[i] < pk * 0.5) break; }
  const width = Math.max(2, e - m0);
  return Math.min(70, m0 + 3 * width);
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
      const xa = x + r + 1, xb = x - r;
      s += src[row + (xa >= w ? w - 1 : xa)] - src[row + (xb < 0 ? 0 : xb)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = Math.round(s / k);
      const ya = y + r + 1, yb = y - r;
      s += tmp[(ya >= h ? h - 1 : ya) * w + x] - tmp[(yb < 0 ? 0 : yb) * w + x];
    }
  }
  return out;
}

// ---------- Otsu 門檻（可限制門檻下限） ----------
export function otsuThreshold(gray, tmin = 0, hist = histogram(gray)) {
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

// 三類 Otsu：在 [tmin,255] 內找兩個門檻 t1<t2 使類間變異最大；回傳 t1、t2 與中間類的像素比例
function otsu3(hist, total, tmin) {
  const P = new Float64Array(257), S = new Float64Array(257);
  for (let i = 0; i < 256; i++) { P[i + 1] = P[i] + hist[i]; S[i + 1] = S[i] + i * hist[i]; }
  const mu = S[256] / total;
  let best = -1, bt1 = -1, bt2 = -1;
  for (let t1 = Math.max(1, tmin); t1 < 254; t1++) {
    const w0 = P[t1 + 1], s0 = S[t1 + 1];
    if (w0 === 0) continue;
    const m0 = s0 / w0;
    for (let t2 = t1 + 1; t2 < 255; t2++) {
      const w1 = P[t2 + 1] - P[t1 + 1], s1 = S[t2 + 1] - S[t1 + 1];
      const w2 = total - P[t2 + 1], s2 = S[256] - S[t2 + 1];
      if (w1 === 0 || w2 === 0) continue;
      const m1 = s1 / w1, m2 = s2 / w2;
      const v = w0 * (m0 - mu) ** 2 + w1 * (m1 - mu) ** 2 + w2 * (m2 - mu) ** 2;
      if (v > best) { best = v; bt1 = t1; bt2 = t2; }
    }
  }
  if (bt1 < 0) return null;
  return { t1: bt1, t2: bt2, midFrac: (P[bt2 + 1] - P[bt1 + 1]) / total };
}

export function thresholdMask(gray, T) {
  const m = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) m[i] = gray[i] > T ? 1 : 0;
  return m;
}

// ---------- 形態學（圓形結構元素） ----------
// 位移表以「平面索引差」預先算好；離邊界 ≥ r 的像素走不檢查邊界的快速路徑
const _discCache = new Map();
function discDeltas(r, w) {
  const key = r + ':' + w;
  let d = _discCache.get(key);
  if (d) return d;
  const dx = [], dy = [], flat = [];
  for (let yy = -r; yy <= r; yy++) for (let xx = -r; xx <= r; xx++) if (xx * xx + yy * yy <= r * r + r * 0.5) { dx.push(xx); dy.push(yy); flat.push(yy * w + xx); }
  d = { dx: Int32Array.from(dx), dy: Int32Array.from(dy), flat: Int32Array.from(flat) };
  if (_discCache.size > 64) _discCache.clear();
  _discCache.set(key, d);
  return d;
}
export function dilate(mask, w, h, r) {
  const out = new Uint8Array(w * h), { dx, dy, flat } = discDeltas(r, w), m = flat.length;
  for (let y = 0; y < h; y++) {
    const inY = y >= r && y < h - r, row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!mask[i]) continue;
      if (inY && x >= r && x < w - r) { for (let k = 0; k < m; k++) out[i + flat[k]] = 1; }
      else for (let k = 0; k < m; k++) {
        const xx = x + dx[k], yy = y + dy[k];
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
      }
    }
  }
  return out;
}
export function erode(mask, w, h, r) {
  const out = new Uint8Array(w * h), { dx, dy, flat } = discDeltas(r, w), m = flat.length;
  for (let y = 0; y < h; y++) {
    const inY = y >= r && y < h - r, row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      if (!mask[i]) continue;
      let ok = 1;
      if (inY && x >= r && x < w - r) { for (let k = 0; k < m; k++) if (!mask[i + flat[k]]) { ok = 0; break; } }
      else for (let k = 0; k < m; k++) {
        const xx = x + dx[k], yy = y + dy[k];
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || !mask[yy * w + xx]) { ok = 0; break; }
      }
      out[i] = ok;
    }
  }
  return out;
}
export const closeMask = (m, w, h, r) => erode(dilate(m, w, h, r), w, h, r);
export const openMask = (m, w, h, r) => dilate(erode(m, w, h, r), w, h, r);

// ---------- 填洞（回傳新遮罩）：從邊界做掃描線填充標記背景，到不了的背景即為洞 ----------
// maxArea：只填面積 ≤ maxArea 的洞（藥上的刻痕、相連藥之間的小縫）。夾鏈袋外框、托盤格線等「封閉的亮線圈」
// 圍出來的大洞不填，否則整個袋子內部會變成一個巨大元件，裡面的反光、皺褶全被當成藥。
export function fillHolesCopy(mask, w, h, maxArea = Infinity) {
  const n = w * h, out = Uint8Array.from(mask), seen = new Uint8Array(n), q = new Int32Array(n);
  // 掃描線填充：從 seeds 出發，把連通的背景像素標成 tag，回傳填到的像素數；fillBuf 為非 null 時把像素索引記進去
  const flood = (seeds, ns, tag, fillBuf) => {
    let qt = 0, cnt = 0;
    for (let k = 0; k < ns; k++) q[qt++] = seeds[k];
    while (qt > 0) {
      const i = q[--qt];
      if (seen[i]) continue;
      const y = (i / w) | 0, row = y * w;
      let x0 = i - row, x1 = x0;
      while (x0 > 0 && !mask[row + x0 - 1] && !seen[row + x0 - 1]) x0--;
      while (x1 < w - 1 && !mask[row + x1 + 1] && !seen[row + x1 + 1]) x1++;
      for (let x = x0; x <= x1; x++) { seen[row + x] = tag; if (fillBuf) fillBuf[cnt] = row + x; cnt++; }
      if (y > 0) { const r2 = row - w; let inRun = 0; for (let x = x0; x <= x1; x++) { const j = r2 + x; if (!mask[j] && !seen[j]) { if (!inRun) { q[qt++] = j; inRun = 1; } } else inRun = 0; } }
      if (y < h - 1) { const r2 = row + w; let inRun = 0; for (let x = x0; x <= x1; x++) { const j = r2 + x; if (!mask[j] && !seen[j]) { if (!inRun) { q[qt++] = j; inRun = 1; } } else inRun = 0; } }
    }
    return cnt;
  };
  const border = new Int32Array(2 * (w + h));
  let nb = 0;
  for (let x = 0; x < w; x++) { if (!mask[x]) border[nb++] = x; const b = (h - 1) * w + x; if (!mask[b]) border[nb++] = b; }
  for (let y = 1; y < h - 1; y++) { const l = y * w; if (!mask[l]) border[nb++] = l; const rr = l + w - 1; if (!mask[rr]) border[nb++] = rr; }
  flood(border, nb, 1, null);
  if (maxArea === Infinity) {
    for (let i = 0; i < n; i++) if (!mask[i] && !seen[i]) out[i] = 1;
    return out;
  }
  const buf = new Int32Array(n), seed = new Int32Array(1);
  for (let i = 0; i < n; i++) {
    if (mask[i] || seen[i]) continue;
    seed[0] = i;
    const cnt = flood(seed, 1, 2, buf);
    if (cnt <= maxArea) for (let k = 0; k < cnt; k++) out[buf[k]] = 1;
  }
  return out;
}

// ---------- 精確歐氏距離轉換（Felzenszwalb & Huttenlocher），回傳「平方距離」；影像外視為背景 ----------
// 加速：1D 轉換直接以步幅讀寫，不複製行列；全背景的行／列（結果必為 0）直接跳過
export function edt(mask, w, h) {
  const W = w + 2, H = h + 2;
  const f = new Float32Array(W * H);
  // 直行：二值輸入的 1D 平方距離轉換 = 到最近背景列的距離平方，用上下兩趟線性掃描即可（外框列為背景）
  for (let x = 0; x < w; x++) {
    let dist = 0, any = 0;
    for (let y = 0, p = x; y < h; y++, p += w) { if (mask[p]) { dist++; any = 1; f[(y + 1) * W + x + 1] = dist * dist; } else dist = 0; }
    if (!any) continue;
    dist = 0;
    for (let y = h - 1, p = (h - 1) * w + x; y >= 0; y--, p -= w) {
      if (mask[p]) { dist++; const k = (y + 1) * W + x + 1, dd = dist * dist; if (dd < f[k]) f[k] = dd; } else dist = 0;
    }
  }
  // 橫列：一般的拋物線下包絡；全 0 的列直接跳過
  const d = new Float32Array(W), v = new Int32Array(W), z = new Float64Array(W + 1);
  const out = new Float32Array(w * h);
  for (let y = 1; y < H - 1; y++) {
    const row = y * W;
    let has = 0;
    for (let x = 1; x < W - 1; x++) if (f[row + x] !== 0) { has = 1; break; }
    if (!has) continue;
    dt1d(f, row, 1, W, d, v, z);
    out.set(d.subarray(1, W - 1), (y - 1) * w);
  }
  return out;
}
// 1D 平方距離轉換：讀 f[off + i*stride]，結果寫到 d[0..n)
function dt1d(f, off, stride, n, d, v, z) {
  let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
  const f0 = f[off];
  let fv = f0, vk = 0;
  for (let q = 1; q < n; q++) {
    const fq = f[off + q * stride];
    let s = ((fq + q * q) - (fv + vk * vk)) / (2 * q - 2 * vk);
    while (s <= z[k]) {
      k--; vk = v[k]; fv = f[off + vk * stride];
      s = ((fq + q * q) - (fv + vk * vk)) / (2 * q - 2 * vk);
    }
    k++; v[k] = q; vk = q; fv = fq; z[k] = s; z[k + 1] = INF;
  }
  k = 0; vk = v[0]; fv = f[off + vk * stride];
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) { k++; vk = v[k]; fv = f[off + vk * stride]; }
    d[q] = (q - vk) * (q - vk) + fv;
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
      const i = q[qh++], y = (i / w) | 0, x = i - y * w;
      c.area++; c.sx += x; c.sy += y;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      if (dt && dt[i] > c.maxDt) { c.maxDt = dt[i]; c.mx = x; c.my = y; }
      if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
        // 內部像素：固定 8 個鄰居（順序與一般路徑相同）
        let j = i - w - 1; if (mask[j] && !labels[j]) { labels[j] = id; q[qt++] = j; }
        j++; if (mask[j] && !labels[j]) { labels[j] = id; q[qt++] = j; }
        j++; if (mask[j] && !labels[j]) { labels[j] = id; q[qt++] = j; }
        j = i - 1; if (mask[j] && !labels[j]) { labels[j] = id; q[qt++] = j; }
        j = i + 1; if (mask[j] && !labels[j]) { labels[j] = id; q[qt++] = j; }
        j = i + w - 1; if (mask[j] && !labels[j]) { labels[j] = id; q[qt++] = j; }
        j++; if (mask[j] && !labels[j]) { labels[j] = id; q[qt++] = j; }
        j++; if (mask[j] && !labels[j]) { labels[j] = id; q[qt++] = j; }
      } else {
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx; if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (mask[j] && !labels[j]) { labels[j] = id; q[qt++] = j; }
          }
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
// 以內切圓面積（maxDt）加權：幾十條細長的袋子邊緣／反光（內切圓很小）合起來的權重也比不過幾顆藥，R 不會被拉低
function estimateRadius(comps, q = 0.8, minArea = 20) {
  let rs = comps.filter(c => c.area >= minArea);
  if (rs.length < 3) rs = comps.filter(c => c.area >= 20);
  if (!rs.length) return 0;
  rs = rs.map(c => c.maxDt).sort((a, b) => a - b);
  let tot = 0;
  for (const v of rs) tot += v;
  if (tot <= 0) return 0;
  let acc = 0;
  for (const v of rs) { acc += v; if (acc >= tot * q) return Math.sqrt(v); }
  return Math.sqrt(rs[rs.length - 1]);
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
  c.dbgCand = cand.length;
  if (cand.length === 0) return [];
  cand.sort((a, b) => b.v - a.v);
  const nms2 = (opt.nms * R) ** 2;
  const greedy = (dtNeck) => {
    const kept = [];
    let nmsDrop = 0, neckDrop = 0;
    outer: for (const p of cand) {
      for (const k of kept) {
        const dx = p.x - k.x, dy = p.y - k.y;
        if (dx * dx + dy * dy < nms2) { nmsDrop++; continue outer; }               // 太近 → 同一顆
        if (!hasNeck(p, k, dtNeck, w, opt.neck)) { neckDrop++; continue outer; }   // 中間沒有變窄 → 同一顆（長錠／膠囊／有壓印的錠）
      }
      kept.push(p);
    }
    return { kept, nmsDrop, neckDrop };
  };
  // 第一次用填洞版距離圖做頸部測試（有壓印的錠不會被誤拆）
  let g = greedy(dtF);
  c.dbgNms = g.nmsDrop; c.dbgNeck = g.neckDrop;
  // 元件自己的內切圓半徑（藥大小不一時，小藥群才不會被大藥的全域 R 影響）
  const rc = Math.max(3, Math.sqrt(c.maxDt));
  // 若找到的顆數明顯少於面積推算（密集排列時藥之間的小空隙被填洞填掉、看不到脖子），改用未填洞版重做，取較多者
  const expected = Math.floor(c.area / (1.3 * Math.PI * rc * rc));
  if (g.kept.length < expected) {
    const g2 = greedy(dtU);
    if (g2.kept.length > g.kept.length) { g = g2; c.dbgRedo = true; }
  }
  const kept = g.kept;
  // 面積上限：一個元件最多能裝幾顆內切圓半徑 rc 的藥
  const nMax = Math.max(1, Math.floor(c.area / (0.6 * Math.PI * rc * rc)));
  c.dbgNMax = nMax; c.dbgKept = kept.length;
  if (kept.length > nMax) kept.length = nMax;
  return kept.map(p => ({ x: p.x, y: p.y, d: Math.sqrt(p.v) }));
}

// 兩個單中心元件：質心距離 ≤ 1.2×等效半徑，且聯集的外接方框圓滿度 ≥ 0.72 → 視為同一顆被切開的錠
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
      if (compact < 0.72) continue; // 半錠連著陰影時外框會略大，放寬一點
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
