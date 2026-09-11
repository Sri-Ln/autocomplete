/**
 * make-icons.mjs — generates icons/icon{16,32,48,128}.png
 *
 *   node tools/make-icons.mjs
 *
 * A one-off generator, not part of the extension. Run it again only if you want
 * to change the mark. No npm: this writes PNG bytes directly, using Node's
 * built-in zlib for the IDAT stream.
 *
 * The mark: a rounded violet square with a white lightning bolt. Drawn with 4×4
 * supersampling so the curves and diagonals are properly anti-aliased at 16px,
 * where Chrome shows it in the toolbar.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

/* ---------------- PNG encoding ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgba: Uint8Array of size w*h*4 */
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Each scanline is prefixed with its filter type; 0 = None.
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- geometry ---------------- */

/** Signed containment for a rounded rectangle in unit space. */
function inRoundedRect(x, y, r) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/* A lightning bolt, in unit coordinates, wound clockwise. */
const BOLT = [
  [0.60, 0.07],
  [0.25, 0.56],
  [0.44, 0.56],
  [0.39, 0.93],
  [0.76, 0.43],
  [0.56, 0.43],
];

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* ---------------- rendering ---------------- */

const BG_TOP = [0x8b, 0x6d, 0xff];
const BG_BOTTOM = [0x62, 0x40, 0xf0];
const FG = [0xff, 0xff, 0xff];

const SS = 4; // supersampling factor per axis

function render(size) {
  const rgba = new Uint8Array(size * size * 4);
  const radius = 0.22;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let fgHits = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          if (!inRoundedRect(x, y, radius)) continue;
          bgHits++;
          if (inPolygon(x, y, BOLT)) fgHits++;
        }
      }

      const total = SS * SS;
      const alpha = bgHits / total;
      const i = (py * size + px) * 4;

      if (alpha === 0) continue;

      // Vertical gradient across the tile.
      const t = py / (size - 1);
      const bg = [0, 1, 2].map((c) => Math.round(BG_TOP[c] + (BG_BOTTOM[c] - BG_TOP[c]) * t));

      // Blend the bolt over the background by its own coverage.
      const boltCoverage = bgHits ? fgHits / bgHits : 0;
      for (let c = 0; c < 3; c++) {
        rgba[i + c] = Math.round(bg[c] + (FG[c] - bg[c]) * boltCoverage);
      }
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }

  return rgba;
}

/* ---------------- go ---------------- */

mkdirSync(new URL('../icons/', import.meta.url), { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const png = encodePNG(size, size, render(size));
  const path = new URL(`../icons/icon${size}.png`, import.meta.url);
  writeFileSync(path, png);
  console.log(`  wrote icons/icon${size}.png  (${png.length} bytes)`);
}

console.log('done');
