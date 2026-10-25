// worker.js — 在背景執行緒跑計數，避免卡住畫面
import { countPills } from './counter.js';
self.onmessage = (e) => {
  const { id, width, height, buffer, opts } = e.data;
  const img = { data: new Uint8ClampedArray(buffer), width, height };
  try {
    const res = countPills(img, opts);
    self.postMessage({ id, ok: true, res }, [res.mask.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.stack || err) });
  }
};
