// test/compare.mjs — 比對兩份快照：node test/compare.mjs a.json b.json
import fs from 'node:fs';
const [a, b] = process.argv.slice(2).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
let diff = 0;
const cmp = (x, y, name) => {
  const same = x.count === y.count && JSON.stringify(x.pills) === JSON.stringify(y.pills) && x.R === y.R && x.T === y.T;
  if (!same) { diff++; console.log(`不同：${name} count ${x.count}→${y.count} R ${x.R}→${y.R} T ${x.T}→${y.T} pills ${JSON.stringify(x.pills) === JSON.stringify(y.pills) ? '同' : '異'}`); }
};
a.synth.forEach((s, i) => cmp(s, b.synth[i], `synth#${s.i}`));
a.real.forEach((s, i) => cmp(s, b.real[i], s.f));
console.log(diff ? `共 ${diff} 處不同` : `完全相同（合成 ${a.synth.length}、真實 ${a.real.length}）`);
process.exit(diff ? 1 : 0);
