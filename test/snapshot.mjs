// test/snapshot.mjs — 結果快照：node test/snapshot.mjs <N> <seed> <bmp資料夾|-> <輸出.json>
// 把合成場景與真實 BMP 的計數結果（顆數、每顆座標、R、門檻）存成 JSON；優化演算法後用 test/compare.mjs 比對是否完全相同
import fs from 'node:fs';
import { countPills } from '../counter.js';
import { makeScene, mulberry32 } from './synth.mjs';
import { readBMP } from './bmp.mjs';
const [N, seed, dir, out] = [Number(process.argv[2] || 200), Number(process.argv[3] || 2), process.argv[4] || '-', process.argv[5] || 'test/out/snapshot.json'];
const rng = mulberry32(seed);
const key = (res) => ({ count: res.count, R: +res.R.toFixed(3), T: +res.threshold.toFixed(3), tmode: res.tmode,
  pills: res.pills.map((p) => [p.x, p.y, p.uncertain ? 1 : 0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]) });
const snap = { synth: [], real: [] };
let t0 = performance.now();
for (let i = 0; i < N; i++) { const sc = makeScene(rng); snap.synth.push({ i, truth: sc.truth, ...key(countPills(sc.img, {})) }); }
const tSynth = (performance.now() - t0) / N;
if (dir !== '-') for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.bmp')).sort()) snap.real.push({ f, ...key(countPills(readBMP(`${dir}/${f}`), {})) });
fs.mkdirSync('test/out', { recursive: true });
fs.writeFileSync(out, JSON.stringify(snap));
const exact = snap.synth.filter((s) => s.count === s.truth).length;
console.log(`合成 ${N} 張 完全正確 ${exact}（${(100 * exact / N).toFixed(1)}%） 平均 ${tSynth.toFixed(1)} ms；真實 ${snap.real.length} 張 → ${out}`);
