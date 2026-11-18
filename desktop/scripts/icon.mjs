// Draws the Trio icon (accent rounded square, three white dots) as a PNG.
// No image dependency: a tiny PNG encoder over node:zlib.
import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function iconPng(size) {
  const ss = 4; // supersampling for smooth edges
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const radius = size * 0.22;
  const dots = [
    [0.5, 0.33],
    [0.32, 0.64],
    [0.68, 0.64],
  ].map(([x, y]) => [x * size, y * size]);
  const dotR = size * 0.13;
  const inRounded = (x, y) => {
    const m = size * 0.04;
    const lo = m + radius, hi = size - m - radius;
    const cx = Math.min(Math.max(x, lo), hi), cy = Math.min(Math.max(y, lo), hi);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      let bg = 0, white = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
          if (!inRounded(px, py)) continue;
          bg++;
          if (dots.some(([dx, dy]) => (px - dx) ** 2 + (py - dy) ** 2 <= dotR ** 2)) white++;
        }
      }
      const total = ss * ss;
      const a = bg / total, w = bg ? white / bg : 0;
      const i = row + 1 + x * 4;
      raw[i] = Math.round(0x58 + (0xff - 0x58) * w);
      raw[i + 1] = Math.round(0x65 + (0xff - 0x65) * w);
      raw[i + 2] = Math.round(0xf2 + (0xff - 0xf2) * w);
      raw[i + 3] = Math.round(255 * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
