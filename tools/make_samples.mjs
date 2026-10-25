// tools/make_samples.mjs — 產生三張合成範例照片到 samples/
import fs from 'node:fs';
import { makeScene, mulberry32, encodePNG } from '../test/synth.mjs';
fs.mkdirSync('samples', { recursive: true });
const specs = [
  ['sample1.png', { tray: { name: 'blue', c: [40, 70, 150], light: true }, shape: 'disc', radius: 26, count: 28, pTouch: 0.3, pillColor: [246, 246, 240], specks: 2 }],
  ['sample2.png', { tray: { name: 'black', c: [28, 28, 32], light: true }, shape: 'capsule', radius: 20, count: 30, pTouch: 0.5, pillColor: [242, 160, 60], specks: 1 }],
  ['sample3.png', { tray: { name: 'white', c: [232, 230, 224], light: false }, shape: 'scored', radius: 24, count: 14, pTouch: 0.2, pillColor: [120, 30, 40], specks: 0 }],
];
let i = 11;
for (const [name, o] of specs) {
  const sc = makeScene(mulberry32(i++), { width: 1000, height: 750, ...o });
  fs.writeFileSync('samples/' + name, encodePNG(sc.img.data, sc.img.width, sc.img.height));
  console.log(name, 'truth=', sc.truth);
}
