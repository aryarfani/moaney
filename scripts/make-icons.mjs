// Generates plain PNG app icons (green tile with a white ring) without dependencies.
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = size / 2, r1 = size * 0.28, r2 = size * 0.17;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cx);
      const ring = d <= r1 && d >= r2;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = ring ? 255 : 0x0e; raw[o + 1] = ring ? 255 : 0x7a; raw[o + 2] = ring ? 255 : 0x55; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [192, 512]) fs.writeFileSync(new URL(`../web/public/icon-${s}.png`, import.meta.url), png(s));
