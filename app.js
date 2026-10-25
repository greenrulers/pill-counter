// app.js — 數藥小幫手 前端邏輯（相機、拍照、辨識、人工修正、紀錄、設定）
import { countPills } from './counter.js';

const VERSION = '1.1.0';
const $ = (s) => document.querySelector(s);
const SETTINGS_KEY = 'pc_settings_v1', HISTORY_KEY = 'pc_history_v1', TARGET_KEY = 'pc_target_v1', TIP_KEY = 'pc_tip_v1';
const defaultSettings = { sensitivity: 0, polarity: 'auto', split: true, showMask: false, live: false, maxSide: 1000 };
const settings = { ...defaultSettings, ...load(SETTINGS_KEY, {}) };
let history = load(HISTORY_KEY, []);

const state = { mode: 'init', stream: null, frame: null, res: null, markers: [], undo: [], R: 12, busy: false, liveBusy: false, liveOn: false };

const els = {
  video: $('#video'), canvas: $('#canvas'), placeholder: $('#placeholder'), placeholderText: $('#placeholderText'),
  badge: $('#badge'), hint: $('#hint'), target: $('#target'), drug: $('#drug'), chips: $('#chips'),
  file: $('#file'), btnShoot: $('#btnShoot'), btnRetake: $('#btnRetake'), btnUndo: $('#btnUndo'), btnSave: $('#btnSave'),
  liveToggle: $('#liveToggle'), busy: $('#busy'), toast: $('#toast'),
  btnSettings: $('#btnSettings'), btnHistory: $('#btnHistory'), dlgSettings: $('#dlgSettings'), dlgHistory: $('#dlgHistory'),
  sensitivity: $('#sensitivity'), sensVal: $('#sensVal'), polarity: $('#polarity'), split: $('#split'), showMask: $('#showMask'), maxSide: $('#maxSide'),
  resetSettings: $('#resetSettings'), historyBody: $('#historyBody'), clearHistory: $('#clearHistory'),
  installTip: $('#installTip'), installClose: $('#installClose'), about: $('#about'),
};
const ctx = els.canvas.getContext('2d');
const off = document.createElement('canvas');
const offCtx = off.getContext('2d', { willReadFrequently: true });
const maskCanvas = document.createElement('canvas');

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
function count(img) {
  const opts = currentOpts();
  if (!worker) return new Promise((res) => setTimeout(() => res(countPills(img, opts)), 0));
  return new Promise((resolve, reject) => {
    const id = ++reqId; pending.set(id, { resolve, reject });
    const copy = new Uint8ClampedArray(img.data);
    worker.postMessage({ id, width: img.width, height: img.height, buffer: copy.buffer, opts }, [copy.buffer]);
  }).catch((err) => { console.warn(err); return countPills(img, opts); });
}

// ---------- 取影格 ----------
function grab(source, sw, sh, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  off.width = w; off.height = h;
  offCtx.drawImage(source, 0, 0, w, h);
  return offCtx.getImageData(0, 0, w, h);
}

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
    const res = await count(img);
    state.frame = img; state.res = res; state.R = res.R || 12;
    state.markers = res.pills.map((p) => ({ x: p.x, y: p.y, uncertain: p.uncertain, manual: false }));
    state.undo = [];
    setMode('result');
    render();
    if (res.warnings.includes('low_contrast')) toast('藥和托盤的顏色太接近，建議換深色托盤或白紙');
    else if (res.warnings.includes('no_foreground')) toast('畫面裡好像沒有藥');
  } catch (e) {
    console.error(e); toast('辨識失敗：' + (e && e.message || e));
    if (wasLive) startLive();
  } finally { state.busy = false; setBusy(false); }
}
function loadImageFile(file) {
  const url = URL.createObjectURL(file);
  loadImageUrl(url, () => URL.revokeObjectURL(url));
}
function loadImageUrl(url, done) {
  const im = new Image();
  im.onload = () => { analyze(grab(im, im.naturalWidth, im.naturalHeight, settings.maxSide)); done && done(); };
  im.onerror = () => { toast('讀不到這張照片'); done && done(); };
  im.src = url;
}

// ---------- 繪製 ----------
function render() {
  const { frame, res } = state; if (!frame) return;
  if (els.canvas.width !== frame.width || els.canvas.height !== frame.height) { els.canvas.width = frame.width; els.canvas.height = frame.height; }
  ctx.putImageData(frame, 0, 0);
  if (settings.showMask && res && res.mask) drawMask(res);
  drawMarkers(state.markers, state.R, true);
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
function drawMarkers(markers, R, numbered) {
  const rad = Math.max(9, R * 0.95);
  const fs = Math.max(12, Math.round(R * 0.85));
  const lw = Math.max(2, R * 0.12);
  ctx.font = `700 ${fs}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  markers.forEach((m, i) => {
    const col = m.manual ? '#38bdf8' : m.uncertain ? '#f59e0b' : '#22c55e';
    ctx.lineWidth = lw; ctx.strokeStyle = col;
    ctx.beginPath(); ctx.arc(m.x, m.y, rad, 0, Math.PI * 2); ctx.stroke();
    if (!numbered) return;
    const label = String(i + 1);
    ctx.lineWidth = Math.max(3, fs * 0.22); ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(label, m.x, m.y);
    ctx.fillStyle = '#fff'; ctx.fillText(label, m.x, m.y);
  });
}
function getTarget() { const v = parseInt(els.target.value, 10); return Number.isFinite(v) && v > 0 ? v : null; }
function updateBadge() {
  const n = state.markers.length, target = getTarget();
  const unc = state.markers.filter((m) => m.uncertain).length;
  let verdict = '顆', cls = '';
  if (target != null) {
    const d = n - target;
    if (d === 0) { verdict = `✓ 與預定 ${target} 顆相符`; cls = 'good'; }
    else if (d > 0) { verdict = `✗ 比預定 ${target} 顆多 ${d} 顆`; cls = 'bad'; }
    else { verdict = `✗ 比預定 ${target} 顆少 ${-d} 顆`; cls = 'bad'; }
  }
  const note = unc ? `橘色標記 ${unc} 個不確定，請目視確認` : '';
  els.badge.className = cls;
  els.badge.innerHTML = `<div class="n">${n}</div><div class="v">${verdict}</div>${note ? `<div class="note">${note}</div>` : ''}`;
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

// ---------- 即時計數 ----------
function startLive() {
  if (state.liveOn) return;
  state.liveOn = true; document.body.dataset.live = '1';
  els.liveToggle.textContent = '即時計數：開'; els.liveToggle.classList.add('on');
  liveTick();
}
function stopLive() {
  state.liveOn = false; document.body.dataset.live = '0';
  els.liveToggle.textContent = '即時計數：關'; els.liveToggle.classList.remove('on');
  if (state.mode === 'camera') els.badge.hidden = true;
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
        ctx.putImageData(img, 0, 0);
        drawMarkers(res.pills, res.R || 10, false);
        const target = getTarget(); const d = target != null ? res.count - target : null;
        els.badge.className = 'live ' + (d == null ? '' : d === 0 ? 'good' : 'bad');
        els.badge.innerHTML = `<div class="n">${res.count}</div><div class="v">${d == null ? '即時' : d === 0 ? '✓ 相符' : d > 0 ? `多 ${d}` : `少 ${-d}`}</div>`;
        els.badge.hidden = false;
      }
    } catch (e) { console.warn(e); }
    finally { state.liveBusy = false; }
  }
  setTimeout(liveTick, 100);
}
els.liveToggle.addEventListener('click', () => {
  settings.live = !state.liveOn; save(SETTINGS_KEY, settings);
  settings.live ? startLive() : stopLive();
});

// ---------- 按鈕 ----------
els.btnShoot.addEventListener('click', shoot);
els.btnRetake.addEventListener('click', async () => {
  state.frame = null; state.res = null; state.markers = [];
  els.badge.hidden = true;
  if (state.stream) { setMode('camera'); if (settings.live) startLive(); }
  else await startCamera();
});
els.file.addEventListener('change', () => { const f = els.file.files && els.file.files[0]; if (f) loadImageFile(f); els.file.value = ''; });
els.btnSave.addEventListener('click', () => {
  const rec = { t: Date.now(), drug: els.drug.value.trim(), target: getTarget(), count: state.markers.length };
  history.unshift(rec); history = history.slice(0, 100); save(HISTORY_KEY, history);
  toast('已儲存到紀錄');
});

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
  els.maxSide.value = String(settings.maxSide);
}
async function settingsChanged(recount) {
  save(SETTINGS_KEY, settings);
  if (state.mode === 'result' && state.frame) {
    if (recount) {
      state.busy = true; setBusy(true);
      try {
        const res = await count(state.frame);
        state.res = res; state.R = res.R || 12;
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
els.resetSettings.addEventListener('click', () => { Object.assign(settings, defaultSettings); syncSettingsUI(); settingsChanged(true); toast('已重設'); });
for (const b of document.querySelectorAll('[data-sample]')) b.addEventListener('click', () => { els.dlgSettings.close(); loadImageUrl(b.dataset.sample); });
els.btnSettings.addEventListener('click', () => { syncSettingsUI(); els.dlgSettings.showModal(); });
els.about.textContent += ` 版本 ${VERSION}。`;

// ---------- 紀錄 ----------
function renderHistory() {
  if (!history.length) { els.historyBody.innerHTML = '<p style="color:var(--muted)">還沒有紀錄。辨識後按「存紀錄」就會出現在這裡。</p>'; return; }
  const rows = history.map((r) => {
    const d = new Date(r.t);
    const time = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const ok = r.target == null ? '' : r.count === r.target ? '<td class="ok">✓</td>' : '<td class="ng">✗</td>';
    return `<tr><td>${time}</td><td>${escapeHtml(r.drug || '—')}</td><td>${r.target ?? '—'}</td><td><b>${r.count}</b></td>${ok || '<td></td>'}</tr>`;
  }).join('');
  els.historyBody.innerHTML = `<table><thead><tr><th>時間</th><th>藥名</th><th>預定</th><th>數到</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
function escapeHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
els.btnHistory.addEventListener('click', () => { renderHistory(); els.dlgHistory.showModal(); });
els.clearHistory.addEventListener('click', () => { if (confirm('確定清除所有紀錄？')) { history = []; save(HISTORY_KEY, history); renderHistory(); } });
for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', () => b.closest('dialog').close());

// ---------- 提示 / 安裝 ----------
let toastTimer = 0;
function toast(msg) { els.toast.textContent = msg; els.toast.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => els.toast.classList.remove('on'), 2600); }
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
const params = new URLSearchParams(location.search);
if (params.get('img')) { setMode('nocam'); loadImageUrl(params.get('img')); }
else startCamera();
