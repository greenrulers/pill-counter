// test/real.mjs — 真實照片測試：node test/real.mjs <資料夾含 .bmp>  （BMP 由 sips -s format bmp 轉出）
import fs from 'node:fs';
import path from 'node:path';
import { countPills } from '../counter.js';
import { encodePNG, drawMarkers } from './synth.mjs';

const dir = process.argv[2];
const OPTS = process.env.PC_OPTS ? JSON.parse(process.env.PC_OPTS) : {};
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'out');
fs.mkdirSync(outDir, { recursive: true });

function readBMP(file) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 2) !== 'BM') throw new Error('not BMP: ' + file);
  const off = b.readUInt32LE(10), w = b.readInt32LE(18); let h = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28), comp = b.readUInt32LE(30);
  const topDown = h < 0; h = Math.abs(h);
  if (!(bpp === 24 || bpp === 32) || (comp !== 0 && comp !== 3)) throw new Error(`unsupported BMP bpp=${bpp} comp=${comp}`);
  const stride = Math.floor((bpp * w + 31) / 32) * 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = off + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const p = row + x * (bpp / 8), q = (y * w + x) * 4;
      data[q] = b[p + 2]; data[q + 1] = b[p + 1]; data[q + 2] = b[p]; data[q + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}
// 盒狀縮小到 maxSide（模擬 app 的處理尺寸）
function downscale(img, maxSide) {
  const s = Math.max(img.width, img.height) / maxSide;
  if (s <= 1) return img;
  const w = Math.round(img.width / s), h = Math.round(img.height / s);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor(x * s), x1 = Math.min(img.width, Math.ceil((x + 1) * s));
    const y0 = Math.floor(y * s), y1 = Math.min(img.height, Math.ceil((y + 1) * s));
    let r = 0, g = 0, b = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const p = (yy * img.width + xx) * 4; r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2]; n++; }
    const q = (y * w + x) * 4; out[q] = r / n; out[q + 1] = g / n; out[q + 2] = b / n; out[q + 3] = 255;
  }
  return { data: out, width: w, height: h };
}

for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.bmp')).sort()) {
  const img = downscale(readBMP(path.join(dir, f)), 1000);
  const t0 = Date.now();
  const res = countPills(img, OPTS);
  const ms = Date.now() - t0;
  const unc = res.pills.filter(p => p.uncertain).length;
  console.log(`${f.padEnd(60)} count=${String(res.count).padStart(3)} unc=${unc} R=${res.R.toFixed(1)} T=${res.threshold.toFixed(0)}/${res.tmode} tmin=${res.tmin} hi=${res.hi} fg=${(res.fgFrac * 100).toFixed(1)}% bg=(${res.bg.r | 0},${res.bg.g | 0},${res.bg.b | 0}) warn=${res.warnings.join(',')} ${ms}ms`);
  fs.writeFileSync(path.join(outDir, f.replace('.bmp', '.png')), encodePNG(drawMarkers(img, res.pills, res.R).data, img.width, img.height));
}
