// app.js — 數藥小幫手 前端邏輯（相機、拍照、相簿、辨識、人工修正、紀錄、設定）
import { countPills } from './counter.js';
import * as DB from './db.js';

const VERSION = '1.2.1';
const $ = (s) => document.querySelector(s);
const SETTINGS_KEY = 'pc_settings_v1', TARGET_KEY = 'pc_target_v1', TIP_KEY = 'pc_tip_v1';
const defaultSettings = { sensitivity: 0, polarity: 'auto', split: true, showMask: false, live: false, maxSide: 1000, autoSave: false };
const settings = { ...defaultSettings, ...load(SETTINGS_KEY, {}) };

const state = { mode: 'init', stream: null, frame: null, frameBitmap: null, res: null, markers: [], undo: [], R: 12, busy: false, liveBusy: false, liveOn: false, savedId: null, autoCount: 0 };

const els = {
  video: $('#video'), canvas: $('#canvas'), placeholder: $('#placeholder'), placeholderText: $('#placeholderText'),
  badge: $('#badge'), hint: $('#hint'), target: $('#target'), drug: $('#drug'), chips: $('#chips'),
  file: $('#file'), btnShoot: $('#btnShoot'), btnRetake: $('#btnRetake'), btnUndo: $('#btnUndo'), btnSave: $('#btnSave'),
  liveToggle: $('#liveToggle'), busy: $('#busy'), toast: $('#toast'),
  btnSettings: $('#btnSettings'), btnHistory: $('#btnHistory'), dlgSettings: $('#dlgSettings'), dlgHistory: $('#dlgHistory'), dlgDetail: $('#dlgDetail'),
  sensitivity: $('#sensitivity'), sensVal: $('#sensVal'), polarity: $('#polarity'), split: $('#split'), showMask: $('#showMask'), maxSide: $('#maxSide'), autoSave: $('#autoSave'),
  resetSettings: $('#resetSettings'), historyBody: $('#historyBody'), clearHistory: $('#clearHistory'), exportCsv: $('#exportCsv'), storageInfo: $('#storageInfo'),
  detailCanvas: $('#detailCanvas'), dTitle: $('#dTitle'), dDrug: $('#dDrug'), dMemo: $('#dMemo'), dSave: $('#dSave'), dShare: $('#dShare'), dShareRaw: $('#dShareRaw'), dReopen: $('#dReopen'), dDelete: $('#dDelete'), dMeta: $('#dMeta'),
  installTip: $('#installTip'), installClose: $('#installClose'), about: $('#about'),
};
const ctx = els.canvas.getContext('2d');
const off = document.createElement('canvas');
const offCtx = off.getContext('2d', { willReadFrequently: true });
const maskCanvas = document.createElement('canvas');
const hasBitmap = typeof createImageBitmap === 'function';

function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

// ---------- 背景執行緒 ----------
let worker = null, reqId = 0;
const pending = new Map();
try {
  worker = new Worker('./worker.js', { type: 'module' });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id);
    e.data.ok ? p.resolve(e.data.res) : p.reject(new Error(e.data.error));
  };
  worker.onerror = (e) => { console.warn('worker 失敗，改用主執行緒', e.message); worker = null; for (const [id, p] of pending) { pending.delete(id); p.reject(new Error('worker')); } };
} catch { worker = null; }

function currentOpts() { return { sensitivity: settings.sensitivity, polarity: settings.polarity, split: settings.split }; }
function count(img, opts = currentOpts()) {
  if (!worker) return new Promise((res) => setTimeout(() => res(countPills(img, opts)), 0));
  return new Promise((resolve, reject) => {
    const id = ++reqId; pending.set(id, { resolve, reject });
    const copy = new Uint8ClampedArray(img.data);
    worker.postMessage({ id, width: img.width, height: img.height, buffer: copy.buffer, opts }, [copy.buffer]);
  }).catch((err) => { console.warn(err); return countPills(img, opts); });
}
// 預熱：先丟一張小圖讓背景執行緒把程式載好、JIT 編譯好，第一次真正拍照才不會多等
function warmUp() {
  const w = 96, h = 96, d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) { const on = ((i >> 2) % w > 30 && (i >> 2) % w < 60 && ((i >> 2) / w | 0) > 30 && ((i >> 2) / w | 0) < 60); d[i] = on ? 240 : 40; d[i + 1] = on ? 240 : 60; d[i + 2] = on ? 240 : 90; d[i + 3] = 255; }
  count({ data: d, width: w, height: h }).catch(() => {});
}

// ---------- 取影格 ----------
function grab(source, sw, sh, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  off.width = w; off.height = h;
  offCtx.drawImage(source, 0, 0, w, h);
  return offCtx.getImageData(0, 0, w, h);
}
// 相簿照片：優先用 createImageBitmap（解碼快、會依 EXIF 轉正），不行再退回 <img>
async function decodeBlob(blob) {
  if (hasBitmap) {
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch {}
    try { return await createImageBitmap(blob); } catch {}
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('decode')); im.src = url; });
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
function bitmapSize(b) { return { w: b.width || b.naturalWidth, h: b.height || b.naturalHeight }; }

// ---------- 模式 ----------
function setMode(m) {
  state.mode = m; document.body.dataset.mode = m;
  if (m === 'camera') {
    els.badge.hidden = !state.liveOn;
    els.hint.textContent = '把藥平鋪在深色托盤上、避免重疊，從正上方拍。';
  } else if (m === 'result') {
    els.hint.textContent = '點一下漏掉的藥可補標記；點已有的標記可移除。橘色＝請目視確認。';
  } else if (m === 'nocam') {
    els.badge.hidden = true;
    els.hint.textContent = '';
  }
}
function setBusy(on) { els.busy.classList.toggle('on', on); els.btnShoot.disabled = on; }

// ---------- 相機 ----------
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    els.placeholderText.textContent = '這個瀏覽器無法使用相機，請改用「從相簿選照片」。';
    setMode('nocam'); return;
  }
  try {
    stopCamera();
    els.placeholderText.textContent = '正在開啟相機…';
    setMode('init');
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false,
    });
    state.stream = stream;
    els.video.srcObject = stream;
    await els.video.play().catch(() => {});
    setMode('camera');
    if (settings.live) startLive();
  } catch (err) {
    console.warn(err);
    els.placeholderText.textContent = (err && err.name === 'NotAllowedError')
      ? '相機權限被拒絕。到 iPhone「設定 → Safari → 相機」改成允許，或改用「從相簿選照片」。'
      : '找不到可用的相機，請改用「從相簿選照片」。';
    setMode('nocam');
  }
}
function stopCamera() {
  stopLive();
  if (state.stream) { for (const t of state.stream.getTracks()) t.stop(); state.stream = null; }
  els.video.srcObject = null;
}

// ---------- 拍照 / 載入照片 → 辨識 ----------
async function shoot() {
  if (state.mode !== 'camera' || state.busy) return;
  const v = els.video;
  if (!v.videoWidth) { toast('相機還沒準備好'); return; }
  const img = grab(v, v.videoWidth, v.videoHeight, settings.maxSide);
  await analyze(img);
}
async function analyze(img) {
  state.busy = true; setBusy(true);
  const wasLive = state.liveOn; stopLive();
  try {
    const t0 = performance.now();
    const res = await count(img);
    state.frame = img; state.res = res; state.R = res.R || 12; state.savedId = null; state.autoCount = res.count;
    if (state.frameBitmap) { try { state.frameBitmap.close(); } catch {} state.frameBitmap = null; }
    if (hasBitmap) createImageBitmap(img).then((b) => { if (state.frame === img) state.frameBitmap = b; else b.close(); }).catch(() => {});
    state.markers = res.pills.map((p) => ({ x: p.x, y: p.y, uncertain: p.uncertain, manual: false }));
    state.undo = [];
    setMode('result');
    render();
    console.info(`辨識 ${img.width}×${img.height} 用了 ${Math.round(performance.now() - t0)} ms`);
    if (res.warnings.includes('low_contrast')) toast('藥和托盤的顏色太接近，建議換深色托盤或白紙');
    else if (res.warnings.includes('no_foreground')) toast('畫面裡好像沒有藥');
    else if (res.warnings.includes('clutter')) toast('背景有袋子邊緣／反光等雜訊（已略過一部分）：建議把藥倒在單色托盤上，或靠近拍讓藥佔滿畫面');
    else if (res.warnings.includes('mostly_uncertain')) toast('超過一半標記不確定：請靠近拍讓藥佔滿畫面，或換單色托盤');
    if (settings.autoSave && res.count > 0) saveRecord(true);
  } catch (e) {
    console.error(e); toast('辨識失敗：' + (e && e.message || e));
    if (wasLive) startLive();
  } finally { state.busy = false; setBusy(false); }
}
async function loadImageBlob(blob) {
  state.busy = true; setBusy(true);
  try {
    const bmp = await decodeBlob(blob);
    const { w, h } = bitmapSize(bmp);
    const img = grab(bmp, w, h, settings.maxSide);
    if (bmp.close) bmp.close();
    state.busy = false; setBusy(false);
    await analyze(img);
  } catch (e) {
    console.warn(e); toast('讀不到這張照片（iPhone 的 HEIC 請在「設定 → 相機 → 格式」改成「最相容」）');
    state.busy = false; setBusy(false);
  }
}
async function loadImageUrl(url) {
  try {
    const r = await fetch(url); if (!r.ok) throw new Error(r.status);
    await loadImageBlob(await r.blob());
  } catch (e) { console.warn(e); toast('讀不到這張照片'); }
}

// ---------- 繪製 ----------
function render() {
  const { frame } = state; if (!frame) return;
  if (els.canvas.width !== frame.width || els.canvas.height !== frame.height) { els.canvas.width = frame.width; els.canvas.height = frame.height; }
  if (state.frameBitmap) ctx.drawImage(state.frameBitmap, 0, 0); else ctx.putImageData(frame, 0, 0);
  if (settings.showMask && state.res && state.res.mask) drawMask(state.res);
  drawMarkers(ctx, state.markers, state.R, true);
  updateBadge();
}
function drawMask(res) {
  const { mask, width: w, height: h } = res;
  const id = ctx.createImageData(w, h); const d = id.data;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) if (mask[i]) { d[p] = 255; d[p + 1] = 40; d[p + 2] = 140; d[p + 3] = 90; }
  maskCanvas.width = w; maskCanvas.height = h;
  maskCanvas.getContext('2d').putImageData(id, 0, 0);
  ctx.drawImage(maskCanvas, 0, 0);
}
function drawMarkers(c, markers, R, numbered) {
  const rad = Math.max(9, R * 0.95);
  const fs = Math.max(12, Math.round(R * 0.85));
  const lw = Math.max(2, R * 0.12);
  c.font = `700 ${fs}px -apple-system, system-ui, sans-serif`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  markers.forEach((m, i) => {
    const col = m.manual ? '#38bdf8' : m.uncertain ? '#f59e0b' : '#22c55e';
    c.lineWidth = lw; c.strokeStyle = col;
    c.beginPath(); c.arc(m.x, m.y, rad, 0, Math.PI * 2); c.stroke();
    if (!numbered) return;
    const label = String(i + 1);
    c.lineWidth = Math.max(3, fs * 0.22); c.strokeStyle = 'rgba(0,0,0,.85)'; c.strokeText(label, m.x, m.y);
    c.fillStyle = '#fff'; c.fillText(label, m.x, m.y);
  });
}
function getTarget() { const v = parseInt(els.target.value, 10); return Number.isFinite(v) && v > 0 ? v : null; }
function verdictOf(n, target) {
  if (target == null) return { text: '顆', cls: '' };
  const d = n - target;
  if (d === 0) return { text: `✓ 與預定 ${target} 顆相符`, cls: 'good' };
  return d > 0 ? { text: `✗ 比預定 ${target} 顆多 ${d} 顆`, cls: 'bad' } : { text: `✗ 比預定 ${target} 顆少 ${-d} 顆`, cls: 'bad' };
}
function updateBadge() {
  const n = state.markers.length, target = getTarget();
  const unc = state.markers.filter((m) => m.uncertain).length;
  const { text, cls } = verdictOf(n, target);
  const note = unc ? `橘色標記 ${unc} 個不確定，請目視確認` : '';
  els.badge.className = cls;
  els.badge.innerHTML = `<div class="n">${n}</div><div class="v">${text}</div>${note ? `<div class="note">${note}</div>` : ''}`;
  els.badge.hidden = false;
}

// ---------- 點擊修正 ----------
function canvasPoint(ev) {
  const r = els.canvas.getBoundingClientRect();
  const scale = Math.min(r.width / els.canvas.width, r.height / els.canvas.height);
  const dw = els.canvas.width * scale, dh = els.canvas.height * scale;
  const ox = r.left + (r.width - dw) / 2, oy = r.top + (r.height - dh) / 2;
  return { x: (ev.clientX - ox) / scale, y: (ev.clientY - oy) / scale };
}
els.canvas.addEventListener('click', (ev) => {
  if (state.mode !== 'result') return;
  const { x, y } = canvasPoint(ev);
  if (x < 0 || y < 0 || x > els.canvas.width || y > els.canvas.height) return;
  state.undo.push(state.markers.map((m) => ({ ...m }))); if (state.undo.length > 30) state.undo.shift();
  const hitR = Math.max(state.R * 1.1, 18);
  let best = -1, bd = hitR * hitR;
  state.markers.forEach((m, i) => { const d = (m.x - x) ** 2 + (m.y - y) ** 2; if (d < bd) { bd = d; best = i; } });
  if (best >= 0) state.markers.splice(best, 1);
  else state.markers.push({ x, y, manual: true, uncertain: false });
  render();
  if (navigator.vibrate) navigator.vibrate(10);
});
els.btnUndo.addEventListener('click', () => { if (!state.undo.length) { toast('沒有可復原的步驟'); return; } state.markers = state.undo.pop(); render(); });

// ---------- 即時計數（相機畫面照常顯示，標記畫在透明疊層上） ----------
function startLive() {
  if (state.liveOn) return;
  state.liveOn = true; document.body.dataset.live = '1';
  els.liveToggle.textContent = '即時計數：開'; els.liveToggle.classList.add('on');
  liveTick();
}
function stopLive() {
  state.liveOn = false; document.body.dataset.live = '0';
  els.liveToggle.textContent = '即時計數：關'; els.liveToggle.classList.remove('on');
  if (state.mode === 'camera') { els.badge.hidden = true; ctx.clearRect(0, 0, els.canvas.width, els.canvas.height); }
}
async function liveTick() {
  if (!state.liveOn || state.mode !== 'camera') return;
  const v = els.video;
  if (v.videoWidth && !state.liveBusy && !state.busy) {
    state.liveBusy = true;
    try {
      const img = grab(v, v.videoWidth, v.videoHeight, 640);
      const res = await count(img);
      if (state.liveOn && state.mode === 'camera') {
        if (els.canvas.width !== img.width || els.canvas.height !== img.height) { els.canvas.width = img.width; els.canvas.height = img.height; }
        ctx.clearRect(0, 0, img.width, img.height);
        drawMarkers(ctx, res.pills, res.R || 10, false);
        const target = getTarget(); const d = target != null ? res.count - target : null;
        els.badge.className = 'live ' + (d == null ? '' : d === 0 ? 'good' : 'bad');
        els.badge.innerHTML = `<div class="n">${res.count}</div><div class="v">${d == null ? '即時' : d === 0 ? '✓ 相符' : d > 0 ? `多 ${d}` : `少 ${-d}`}</div>`;
        els.badge.hidden = false;
      }
    } catch (e) { console.warn(e); }
    finally { state.liveBusy = false; }
  }
  setTimeout(liveTick, 80);
}
els.liveToggle.addEventListener('click', () => {
  settings.live = !state.liveOn; save(SETTINGS_KEY, settings);
  settings.live ? startLive() : stopLive();
});

// ---------- 按鈕 ----------
els.btnShoot.addEventListener('click', shoot);
els.btnRetake.addEventListener('click', async () => {
  state.frame = null; state.res = null; state.markers = []; state.savedId = null;
  if (state.frameBitmap) { try { state.frameBitmap.close(); } catch {} state.frameBitmap = null; }
  els.badge.hidden = true;
  if (state.stream) { setMode('camera'); if (settings.live) startLive(); }
  else await startCamera();
});
els.file.addEventListener('change', () => { const f = els.file.files && els.file.files[0]; if (f) loadImageBlob(f); els.file.value = ''; });
els.btnSave.addEventListener('click', () => saveRecord(false));

// ---------- 預定數量 ----------
const QUICK = [7, 14, 21, 28, 30, 42, 56, 60, 84, 90, 100];
for (const q of QUICK) {
  const b = document.createElement('button'); b.className = 'chip'; b.textContent = q;
  b.addEventListener('click', () => { els.target.value = q; onTargetChange(); });
  els.chips.appendChild(b);
}
function onTargetChange() {
  const t = getTarget();
  for (const b of els.chips.children) b.classList.toggle('on', t != null && Number(b.textContent) === t);
  save(TARGET_KEY, els.target.value);
  if (state.mode === 'result') updateBadge();
}
els.target.addEventListener('input', onTargetChange);
$('#tMinus').addEventListener('click', () => { els.target.value = Math.max(0, (getTarget() || 0) - 1) || ''; onTargetChange(); });
$('#tPlus').addEventListener('click', () => { els.target.value = (getTarget() || 0) + 1; onTargetChange(); });
els.target.value = load(TARGET_KEY, '') || ''; onTargetChange();

// ---------- 設定 ----------
function syncSettingsUI() {
  els.sensitivity.value = settings.sensitivity; els.sensVal.textContent = settings.sensitivity;
  els.polarity.value = settings.polarity; els.split.checked = settings.split; els.showMask.checked = settings.showMask;
  els.maxSide.value = String(settings.maxSide); els.autoSave.checked = settings.autoSave;
}
async function settingsChanged(recount) {
  save(SETTINGS_KEY, settings);
  if (state.mode === 'result' && state.frame) {
    if (recount) {
      state.busy = true; setBusy(true);
      try {
        const res = await count(state.frame);
        state.res = res; state.R = res.R || 12; state.autoCount = res.count;
        state.markers = res.pills.map((p) => ({ x: p.x, y: p.y, uncertain: p.uncertain, manual: false }));
      } finally { state.busy = false; setBusy(false); }
    }
    render();
  }
}
els.sensitivity.addEventListener('input', () => { els.sensVal.textContent = els.sensitivity.value; });
els.sensitivity.addEventListener('change', () => { settings.sensitivity = Number(els.sensitivity.value); settingsChanged(true); });
els.polarity.addEventListener('change', () => { settings.polarity = els.polarity.value; settingsChanged(true); });
els.split.addEventListener('change', () => { settings.split = els.split.checked; settingsChanged(true); });
els.showMask.addEventListener('change', () => { settings.showMask = els.showMask.checked; settingsChanged(false); });
els.maxSide.addEventListener('change', () => { settings.maxSide = Number(els.maxSide.value); settingsChanged(false); });
els.autoSave.addEventListener('change', () => { settings.autoSave = els.autoSave.checked; save(SETTINGS_KEY, settings); });
els.resetSettings.addEventListener('click', () => { Object.assign(settings, defaultSettings); syncSettingsUI(); settingsChanged(true); toast('已重設'); });
for (const b of document.querySelectorAll('[data-sample]')) b.addEventListener('click', () => { els.dlgSettings.close(); loadImageUrl(b.dataset.sample); });
els.btnSettings.addEventListener('click', () => { syncSettingsUI(); els.dlgSettings.showModal(); });
els.about.textContent += ` 版本 ${VERSION}。`;

// ---------- 紀錄：儲存（含縮圖與處理後原圖） ----------
function canvasToBlob(c, type, q) { return new Promise((res) => c.toBlob((b) => res(b), type, q)); }
async function makeImages(frame) {
  const src = state.frameBitmap || (() => { const t = document.createElement('canvas'); t.width = frame.width; t.height = frame.height; t.getContext('2d').putImageData(frame, 0, 0); return t; })();
  const big = document.createElement('canvas'); big.width = frame.width; big.height = frame.height;
  big.getContext('2d').drawImage(src, 0, 0);
  const s = 240 / Math.max(frame.width, frame.height);
  const th = document.createElement('canvas'); th.width = Math.max(1, Math.round(frame.width * s)); th.height = Math.max(1, Math.round(frame.height * s));
  th.getContext('2d').drawImage(src, 0, 0, th.width, th.height);
  const [image, thumb] = await Promise.all([canvasToBlob(big, 'image/jpeg', 0.82), canvasToBlob(th, 'image/jpeg', 0.7)]);
  return { image, thumb };
}
async function saveRecord(auto) {
  if (!state.frame) return;
  const markers = state.markers.map((m) => ({ x: Math.round(m.x), y: Math.round(m.y), u: m.uncertain ? 1 : 0, m: m.manual ? 1 : 0 }));
  const base = {
    t: Date.now(), drug: els.drug.value.trim(), target: getTarget(), count: markers.length, auto: state.autoCount,
    manualAdd: markers.filter((m) => m.m).length, uncertain: markers.filter((m) => m.u).length,
    markers, w: state.frame.width, h: state.frame.height, R: Math.round(state.R * 10) / 10, ver: 2,
  };
  try {
    if (state.savedId) {
      const { t, ...patch } = base;
      await DB.updateRecord(state.savedId, patch);
      toast('紀錄已更新');
    } else {
      const { image, thumb } = await makeImages(state.frame);
      state.savedId = await DB.addRecord({ ...base, memo: '', image, thumb });
      DB.requestPersist();
      toast(auto ? '已自動存紀錄（含照片）' : '已儲存到紀錄（含照片）');
    }
  } catch (e) {
    console.warn(e);
    toast('無法儲存照片紀錄：' + (e && e.message || '瀏覽器不支援或空間不足'));
  }
}

// ---------- 紀錄：清單 ----------
let recordsCache = [];
const fmtTime = (t) => { const d = new Date(t); return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const blobUrls = [];
function freeBlobUrls() { for (const u of blobUrls) URL.revokeObjectURL(u); blobUrls.length = 0; }
async function renderHistory() {
  freeBlobUrls();
  try { recordsCache = await DB.listRecords(500); }
  catch (e) { els.historyBody.innerHTML = `<p style="color:var(--muted)">無法讀取紀錄：${escapeHtml(String(e && e.message || e))}</p>`; return; }
  if (!recordsCache.length) { els.historyBody.innerHTML = '<p style="color:var(--muted)">還沒有紀錄。辨識後按「存紀錄」就會出現在這裡（會連照片一起存在這支手機裡）。</p>'; }
  else {
    els.historyBody.innerHTML = recordsCache.map((r) => {
      const v = r.target == null ? '' : r.count === r.target ? '<span class="ok">✓ 相符</span>' : `<span class="ng">✗ 差 ${r.count - r.target > 0 ? '+' : ''}${r.count - r.target}</span>`;
      let img = '<div class="thumb none">無圖</div>';
      if (r.thumb) { const u = URL.createObjectURL(r.thumb); blobUrls.push(u); img = `<img class="thumb" src="${u}" alt="">`; }
      return `<button class="rec" data-id="${r.id}">${img}<div class="meta"><div class="l1"><b>${r.count}</b> 顆${r.target != null ? ` / 預定 ${r.target}` : ''} ${v}</div><div class="l2">${escapeHtml(r.drug || '（未填藥名）')}${r.memo ? ' · ' + escapeHtml(r.memo) : ''}</div><div class="l3">${fmtTime(r.t)}${r.manualAdd ? ` · 手動補 ${r.manualAdd}` : ''}${r.uncertain ? ` · 不確定 ${r.uncertain}` : ''}</div></div></button>`;
    }).join('');
  }
  const info = await DB.storageInfo();
  els.storageInfo.textContent = `${recordsCache.length} 筆` + (info ? `，已用約 ${info.usageMB < 1 ? '<1' : info.usageMB.toFixed(0)} MB（此裝置可用約 ${(info.quotaMB / 1024).toFixed(1)} GB）` : '') + '。照片只存在這支手機裡。';
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
els.btnHistory.addEventListener('click', () => { els.dlgHistory.showModal(); renderHistory(); });
els.dlgHistory.addEventListener('close', freeBlobUrls);
els.historyBody.addEventListener('click', (ev) => { const b = ev.target.closest('.rec'); if (b) openDetail(Number(b.dataset.id)); });
els.clearHistory.addEventListener('click', async () => {
  if (!recordsCache.length) return;
  if (confirm(`確定清除全部 ${recordsCache.length} 筆紀錄（含照片）？此動作無法復原。`)) { try { await DB.clearRecords(); } catch {} renderHistory(); }
});

// ---------- 紀錄：匯出 CSV ----------
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
els.exportCsv.addEventListener('click', () => {
  if (!recordsCache.length) { toast('沒有紀錄可匯出'); return; }
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['時間', '藥名', '預定數量', '數到', '差額', '自動辨識', '手動補', '不確定', '備註'].map(esc).join(',')];
  for (const r of recordsCache) rows.push([fmtTime(r.t), r.drug, r.target ?? '', r.count, r.target == null ? '' : r.count - r.target, r.auto ?? '', r.manualAdd ?? '', r.uncertain ?? '', r.memo].map(esc).join(','));
  const d = new Date(), name = `數藥紀錄_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`;
  download(new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }), name);
});

// ---------- 紀錄：單筆詳情（看圖、改藥名備註、分享、重新開啟、刪除） ----------
let detail = null;
async function openDetail(id) {
  let rec;
  try { rec = await DB.getRecord(id); } catch (e) { toast('讀不到這筆紀錄'); return; }
  if (!rec) { toast('紀錄不存在'); return; }
  detail = { rec, bmp: null };
  const { text, cls } = verdictOf(rec.count, rec.target);
  els.dTitle.textContent = `${rec.count} 顆`;
  els.dMeta.innerHTML = `<span class="${cls}">${rec.target == null ? '' : text}</span> ${fmtTime(rec.t)}` + (rec.auto != null && rec.auto !== rec.count ? ` · 自動辨識 ${rec.auto}，人工修正後 ${rec.count}` : '') + (rec.uncertain ? ` · ${rec.uncertain} 個不確定` : '');
  els.dDrug.value = rec.drug || ''; els.dMemo.value = rec.memo || '';
  const dc = els.detailCanvas, dctx = dc.getContext('2d');
  if (rec.image) {
    try {
      const bmp = await decodeBlob(rec.image); detail.bmp = bmp;
      const { w, h } = bitmapSize(bmp);
      dc.width = w; dc.height = h; dc.hidden = false;
      dctx.drawImage(bmp, 0, 0);
      drawMarkers(dctx, rec.markers.map((m) => ({ x: m.x, y: m.y, uncertain: !!m.u, manual: !!m.m })), rec.R || 12, true);
    } catch { dc.hidden = true; }
  } else { dc.hidden = true; }
  els.dReopen.disabled = !rec.image; els.dShare.disabled = !rec.image; els.dShareRaw.disabled = !rec.image;
  els.dlgDetail.showModal();
}
els.dlgDetail.addEventListener('close', () => { if (detail && detail.bmp && detail.bmp.close) detail.bmp.close(); detail = null; });
els.dSave.addEventListener('click', async () => {
  if (!detail) return;
  try { await DB.updateRecord(detail.rec.id, { drug: els.dDrug.value.trim(), memo: els.dMemo.value.trim() }); toast('已更新'); els.dlgDetail.close(); renderHistory(); }
  catch (e) { toast('更新失敗'); }
});
els.dDelete.addEventListener('click', async () => {
  if (!detail) return;
  if (!confirm('刪除這筆紀錄（含照片）？')) return;
  try { await DB.deleteRecord(detail.rec.id); toast('已刪除'); els.dlgDetail.close(); renderHistory(); } catch { toast('刪除失敗'); }
});
els.dShare.addEventListener('click', async () => {
  if (!detail || els.detailCanvas.hidden) return;
  const r = detail.rec;
  const blob = await canvasToBlob(els.detailCanvas, 'image/jpeg', 0.85);
  const name = `數藥_${r.drug || '未命名'}_${r.count}顆_${new Date(r.t).toISOString().slice(0, 10)}.jpg`;
  const file = new File([blob], name, { type: 'image/jpeg' });
  const text = `${r.drug ? r.drug + ' ' : ''}${r.count} 顆${r.target != null ? `（預定 ${r.target}）` : ''} ${fmtTime(r.t)}`;
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], text }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  download(blob, name);
});
els.dShareRaw.addEventListener('click', async () => {
  if (!detail || !detail.rec.image) return;
  const r = detail.rec;
  const name = `數藥原圖_${r.drug || '未命名'}_自動${r.auto ?? r.count}顆_${new Date(r.t).toISOString().slice(0, 10)}.jpg`;
  const file = new File([r.image], name, { type: 'image/jpeg' });
  const text = `數藥小幫手回報：自動辨識 ${r.auto ?? r.count} 顆，實際 ${r.count} 顆，R=${r.R}，${r.w}×${r.h}，版本 ${VERSION}`;
  if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], text }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  download(r.image, name);
});
els.dReopen.addEventListener('click', async () => {
  if (!detail || !detail.bmp) return;
  const r = detail.rec, bmp = detail.bmp;
  const { w, h } = bitmapSize(bmp);
  off.width = w; off.height = h; offCtx.drawImage(bmp, 0, 0);
  const img = offCtx.getImageData(0, 0, w, h);
  stopCamera();
  state.frame = img; state.res = null; state.R = r.R || 12; state.savedId = r.id; state.autoCount = r.auto ?? r.count;
  if (state.frameBitmap) { try { state.frameBitmap.close(); } catch {} state.frameBitmap = null; }
  if (hasBitmap) createImageBitmap(img).then((b) => { if (state.frame === img) state.frameBitmap = b; else b.close(); }).catch(() => {});
  state.markers = r.markers.map((m) => ({ x: m.x, y: m.y, uncertain: !!m.u, manual: !!m.m }));
  state.undo = [];
  els.drug.value = r.drug || ''; if (r.target != null) { els.target.value = r.target; onTargetChange(); }
  els.dlgDetail.close(); els.dlgHistory.close();
  setMode('result'); render();
  toast('已重新開啟，修改後按「存紀錄」會更新這筆');
});
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());

// ---------- 提示 / 安裝 ----------
let toastTimer = 0;
function toast(msg) { els.toast.textContent = msg; els.toast.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => els.toast.classList.remove('on'), 2800); }
const isStandalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
const isiOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
if (isiOS && !isStandalone && !load(TIP_KEY, false)) els.installTip.classList.add('on');
els.installClose.addEventListener('click', () => { els.installTip.classList.remove('on'); save(TIP_KEY, true); });

// ---------- 離線快取 ----------
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw && nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) toast('有新版本，下次開啟就會更新'); });
    });
  }).catch(() => {});
}

// ---------- 生命週期 ----------
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (state.mode === 'camera') stopCamera(); }
  else if (state.mode === 'camera' && !state.stream) startCamera();
});

// ---------- 啟動 ----------
warmUp();
DB.migrateFromLocalStorage().then((n) => { if (n) console.info(`已搬移 ${n} 筆舊紀錄`); }).catch(() => {});
const params = new URLSearchParams(location.search);
if (params.get('img')) { setMode('nocam'); loadImageUrl(params.get('img')); }
else startCamera();
