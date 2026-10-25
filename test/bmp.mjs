// test/bmp.mjs — 讀 BMP（24/32 位元，sips -s format bmp 轉出的檔案）→ {data,width,height}
import fs from 'node:fs';
export function readBMP(file) {
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
