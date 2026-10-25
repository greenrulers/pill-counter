// test/run.mjs — 合成影像批次測試：node test/run.mjs [場景數] [seed]
import fs from 'node:fs';
import path from 'node:path';
import { countPills } from '../counter.js';
import { makeScene, mulberry32, encodePNG, drawMarkers } from './synth.mjs';

const N = Number(process.argv[2] || 200);
const seed = Number(process.argv[3] || 1);
const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'out');
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (f.endsWith('.png')) fs.unlinkSync(path.join(outDir, f));

const OPTS = process.env.PC_OPTS ? JSON.parse(process.env.PC_OPTS) : {};
const rng = mulberry32(seed);
let exact = 0, within1 = 0, absErr = 0, over = 0, under = 0, t0 = Date.now();
const byKey = {};
const fails = [];
for (let i = 0; i < N; i++) {
  const sc = makeScene(rng);
  const res = countPills(sc.img, OPTS);
  const diff = res.count - sc.truth;
  if (diff === 0) exact++;
  if (Math.abs(diff) <= 1) within1++;
  absErr += Math.abs(diff);
  if (diff > 0) over++; if (diff < 0) under++;
  for (const key of [sc.meta.shape, 'touch=' + sc.meta.pTouch, sc.meta.tray]) {
    byKey[key] ??= { n: 0, ok: 0 }; byKey[key].n++; if (diff === 0) byKey[key].ok++;
  }
  if (diff !== 0) {
    fails.push({ i, truth: sc.truth, count: res.count, diff, ...sc.meta, R: res.R.toFixed(1), T: res.threshold.toFixed(0), unc: res.pills.filter(p => p.uncertain).length, warn: res.warnings.join(',') });
    if (fails.length <= 12) fs.writeFileSync(path.join(outDir, `fail_${i}_t${sc.truth}_c${res.count}.png`), encodePNG(drawMarkers(sc.img, res.pills, res.R).data, sc.img.width, sc.img.height));
  }
}
const ms = (Date.now() - t0) / N;
console.log(JSON.stringify(OPTS), `scenes=${N} exact=${(100 * exact / N).toFixed(1)}% within±1=${(100 * within1 / N).toFixed(1)}% MAE=${(absErr / N).toFixed(3)} over=${over} under=${under} avg=${ms.toFixed(0)}ms/scene`);
for (const [k, v] of Object.entries(byKey).sort()) console.log(`  ${k.padEnd(12)} ${v.ok}/${v.n} (${(100 * v.ok / v.n).toFixed(0)}%)`);
if (fails.length) { console.log('--- failures ---'); for (const f of fails.slice(0, 40)) console.log(JSON.stringify(f)); }
