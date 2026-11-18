/**
 * A small red dot with a number for Windows' taskbar overlay icon
 * (`app.setBadgeCount` does nothing there). Drawn into a raw BGRA bitmap so
 * no image asset or canvas is needed.
 */

// 3x5 pixel digits, rows top to bottom, 3 bits per row.
const DIGITS: Record<string, number[]> = {
  "0": [7, 5, 5, 5, 7], "1": [2, 6, 2, 2, 7], "2": [7, 1, 7, 4, 7],
  "3": [7, 1, 7, 1, 7], "4": [5, 5, 7, 1, 1], "5": [7, 4, 7, 1, 7],
  "6": [7, 4, 7, 5, 7], "7": [7, 1, 1, 1, 1], "8": [7, 5, 7, 5, 7],
  "9": [7, 5, 7, 1, 7], "+": [0, 2, 7, 2, 0],
};

/** 16x16 BGRA bitmap: red disc, white digits (at most two glyphs). */
export function badgeBitmap(text: string): Buffer {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const put = (x: number, y: number, r: number, g: number, b: number, a: number): void => {
    const i = (y * size + x) * 4;
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - 7.5, dy = y - 7.5;
      if (dx * dx + dy * dy <= 7.6 * 7.6) put(x, y, 0xe0, 0x24, 0x24, 0xff);
    }
  }
  const glyphs = (text.length > 2 ? "9+" : text).split("");
  const width = glyphs.length * 4 - 1;
  let left = Math.floor((size - width) / 2);
  for (const ch of glyphs) {
    const rows = DIGITS[ch];
    if (rows) {
      rows.forEach((bits, row) => {
        for (let col = 0; col < 3; col++) {
          if (bits & (4 >> col)) put(left + col, 5 + row, 0xff, 0xff, 0xff, 0xff);
        }
      });
    }
    left += 4;
  }
  return buf;
}
