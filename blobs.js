// blobs.js — 圓形偵測（「中心點法」）：不先切前景，直接找影像裡「大小一致的圓」
//
// 用途：藥裝在透明夾鏈袋裡、或托盤霧狀反光與藥的對比差不多時，分割法會把袋子和藥黏成一團；
// 圓形偵測只看「有沒有一圈徑向邊緣」，袋子的霧、皺褶、直線邊緣不是圓，投不出尖峰也通不過整圈驗證。
// 相連的藥錠之間仍有暗縫（接觸陰影），所以每顆仍是自己的一個圓。
//
// 做法（圓形霍夫轉換的梯度投票版，類似 OpenCV HoughCircles；純 JS、工作尺寸長邊約 500）：
//   1. 亮度 → Sobel 梯度；梯度夠強的像素為邊緣
//   2. 每個邊緣像素沿梯度方向（兩側都投，藥比底亮或暗都行）對每個候選半徑 r 的圓心累加器投票（權重＝梯度強度）
//   3. 每個尺度的累加器做小方塊和（容忍不完美的圓）、除以圓周長 → 「圓周平均邊緣強度」；取局部極大值 → 跨尺度非極大抑制
//   4. 整圈驗證：圓周 24 個角度，在半徑 r±1 處梯度夠強且方向接近徑向的比例（support）≥ 0.55 才算圓
//   5. 半徑一致性：以分數加權的半徑中位數當藥錠大小，只留相近者（藥大小一致、雜訊大小雜亂）
// 輸出：{ pills:[{x,y,r,uncertain,score,support}], R, quality, candidates }
//   quality = 強圓（support ≥ 0.75）的比例；count ≥ 3 且 quality 高才值得採用

export function detectCircles(img, options = {}) {
  const o = { work: 500, rMin: 5, step: 1.15, gradMin: 10, scoreMin: 6, ...options };
  const { data, width: w, height: h } = img;
  // ---- 1. 亮度縮到工作尺寸 ----
  const f = Math.max(1, Math.round(Math.max(w, h) / o.work));
  const ww = Math.floor(w / f), hh = Math.floor(h / f), n = ww * hh;
  const L = new Float32Array(n);
  const inv = 1 / (f * f);
  for (let y = 0; y < hh; y++) for (let x = 0; x < ww; x++) {
    let s = 0;
    for (let dy = 0; dy < f; dy++) { let p = ((y * f + dy) * w + x * f) * 4; for (let dx = 0; dx < f; dx++, p += 4) s += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]; }
    L[y * ww + x] = s * inv;
  }
  // Sobel
  const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
  for (let y = 1; y < hh - 1; y++) for (let x = 1; x < ww - 1; x++) {
    const i = y * ww + x;
    const a = L[i - ww - 1], b = L[i - ww], c = L[i - ww + 1], d = L[i - 1], e = L[i + 1], g = L[i + ww - 1], k = L[i + ww], m = L[i + ww + 1];
    const sx = (c + 2 * e + m - a - 2 * d - g) / 4, sy = (g + 2 * k + m - a - 2 * b - c) / 4;
    gx[i] = sx; gy[i] = sy; mag[i] = Math.sqrt(sx * sx + sy * sy);
  }
  const rMax = Math.min(ww, hh) / 6;
  const radii = [];
  for (let r = o.rMin; r <= rMax; r *= o.step) radii.push(r);
  if (radii.length < 2) return { pills: [], R: 0, quality: 0, candidates: 0, f };

  // ---- 2. 投票 ----
  const edges = [];
  for (let i = 0; i < n; i++) if (mag[i] >= o.gradMin) edges.push(i);
  const K = radii.length;
  const acc = new Float32Array(K * n);
  for (const i of edges) {
    const y = (i / ww) | 0, x = i - y * ww, m = mag[i], ux = gx[i] / m, uy = gy[i] / m;
    for (let k = 0; k < K; k++) {
      const r = radii[k], base = k * n;
      const x1 = Math.round(x + ux * r), y1 = Math.round(y + uy * r);
      if (x1 >= 0 && y1 >= 0 && x1 < ww && y1 < hh) acc[base + y1 * ww + x1] += m;
      const x2 = Math.round(x - ux * r), y2 = Math.round(y - uy * r);
      if (x2 >= 0 && y2 >= 0 && x2 < ww && y2 < hh) acc[base + y2 * ww + x2] += m;
    }
  }
  // ---- 3. 每個尺度：方塊和 → 圓周平均邊緣強度 → 局部極大值 ----
  const cand = [];
  const sum = new Float32Array(n), tmp = new Float32Array(n);
  for (let k = 0; k < K; k++) {
    const r = radii[k], br = Math.max(1, Math.round(0.12 * r));
    boxSum(acc.subarray(k * n, (k + 1) * n), ww, hh, br, sum, tmp);
    const norm = 1 / (2 * Math.PI * r);
    for (let y = 1; y < hh - 1; y++) for (let x = 1; x < ww - 1; x++) {
      const i = y * ww + x, v = sum[i];
      if (v * norm < o.scoreMin) continue;
      if (v < sum[i - 1] || v < sum[i + 1] || v < sum[i - ww] || v < sum[i + ww] ||
          v < sum[i - ww - 1] || v < sum[i - ww + 1] || v < sum[i + ww - 1] || v < sum[i + ww + 1]) continue;
      cand.push({ x, y, r, s: v * norm });
    }
  }
  cand.sort((p, q) => q.s - p.s);
  // 跨尺度非極大抑制：距離 < 0.8 × 較大半徑者視為同一個圓（同心不同半徑的重複會被壓掉）
  let kept = [];
  outer: for (const p of cand) {
    for (const q of kept) {
      const lim = 0.8 * Math.max(p.r, q.r), dx = p.x - q.x, dy = p.y - q.y;
      if (dx * dx + dy * dy < lim * lim) continue outer;
    }
    kept.push(p);
    if (kept.length >= 800) break;
  }
  const candidates = kept.length;
  if (!candidates) return { pills: [], R: 0, quality: 0, candidates, f };

  // ---- 4. 整圈驗證：徑向邊緣支持度 ----
  const NA = 24;
  const support = (p) => {
    let ok = 0;
    for (let a = 0; a < NA; a++) {
      const ang = (a / NA) * Math.PI * 2, cx = Math.cos(ang), sy = Math.sin(ang);
      let best = 0;
      for (let dr = -1; dr <= 1; dr++) {
        const rr = p.r + dr, x = Math.round(p.x + cx * rr), y = Math.round(p.y + sy * rr);
        if (x < 1 || y < 1 || x >= ww - 1 || y >= hh - 1) continue;
        const i = y * ww + x, m = mag[i];
        if (m < 0.6 * o.gradMin) continue;
        const align = Math.abs(gx[i] * cx + gy[i] * sy) / m; // 梯度與徑向夾角的餘弦
        if (align > best) best = align;
      }
      if (best >= 0.7) ok++;
    }
    return ok / NA;
  };
  for (const p of kept) p.sup = support(p);
  kept = kept.filter((p) => p.sup >= 0.55);
  if (!kept.length) return { pills: [], R: 0, quality: 0, candidates, f };

  // ---- 5. 半徑一致性 ----
  const byR = kept.slice().sort((p, q) => p.r - q.r);
  let tot = 0; for (const p of byR) tot += p.s * p.sup;
  let accw = 0, rm = byR[byR.length - 1].r;
  for (const p of byR) { accw += p.s * p.sup; if (accw >= tot / 2) { rm = p.r; break; } }
  const sized = kept.filter((p) => p.r >= 0.6 * rm && p.r <= 1.5 * rm);
  // 同半徑下再做一次非極大抑制（距離 < 1.0 × rm）
  const final = [];
  outer2: for (const p of sized.sort((a, b) => b.s * b.sup - a.s * a.sup)) {
    for (const q of final) { const dx = p.x - q.x, dy = p.y - q.y; if (dx * dx + dy * dy < rm * rm) continue outer2; }
    final.push(p);
  }
  // 相對分數門檻：強圓分數中位數的 25% 以下視為雜訊（袋子邊角偶然湊出的弱圓）
  const strongScores = final.filter((p) => p.sup >= 0.75).map((p) => p.s).sort((a, b) => a - b);
  const sMed = strongScores.length ? strongScores[strongScores.length >> 1] : 0;
  const good = final.filter((p) => p.s >= 0.25 * sMed);
  let strong = 0;
  const pills = good.map((p) => {
    const st = p.sup >= 0.75;
    if (st) strong++;
    return { x: (p.x + 0.5) * f, y: (p.y + 0.5) * f, r: p.r * f, uncertain: !st, score: p.s, support: p.sup };
  });
  return { pills, R: rm * f, quality: pills.length ? strong / pills.length : 0, candidates, f };
}

// 方塊和（邊界外視為 0），結果寫進 out；tmp 為暫存
function boxSum(src, w, h, r, out, tmp) {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = 0; x <= r && x < w; x++) s += src[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      const xa = x + r + 1, xb = x - r;
      if (xa < w) s += src[row + xa];
      if (xb >= 0) s -= src[row + xb];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y <= r && y < h; y++) s += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s;
      const ya = y + r + 1, yb = y - r;
      if (ya < h) s += tmp[ya * w + x];
      if (yb >= 0) s -= tmp[yb * w + x];
    }
  }
}
