// Genereert de extensie-iconen zonder externe dependencies.
// Gebruik: node tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'icons');
const S = 512;

// ----------------------------------------------------------------- PNG-writer

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- tekenen

const pixels = new Float32Array(S * S * 4);

function put(x, y, r, g, b, a = 1) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const inv = 1 - a;
  pixels[i] = pixels[i] * inv + r * a;
  pixels[i + 1] = pixels[i + 1] * inv + g * a;
  pixels[i + 2] = pixels[i + 2] * inv + b * a;
  pixels[i + 3] = Math.min(1, pixels[i + 3] + a);
}

function insideRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function roundRect(x0, y0, x1, y1, r, color) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      if (insideRoundRect(x + 0.5, y + 0.5, x0, y0, x1, y1, r)) put(x, y, ...color);
    }
  }
}

function circle(cx, cy, radius, color) {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) put(x, y, ...color);
    }
  }
}

const lerp = (a, b, t) => a + (b - a) * t;

// Achtergrond: verticale gradient met afgeronde hoeken.
const TOP = [28, 181, 224];
const BOTTOM = [11, 94, 168];
for (let y = 0; y < S; y++) {
  const t = y / (S - 1);
  const color = [
    lerp(TOP[0], BOTTOM[0], t) / 255,
    lerp(TOP[1], BOTTOM[1], t) / 255,
    lerp(TOP[2], BOTTOM[2], t) / 255,
  ];
  for (let x = 0; x < S; x++) {
    if (insideRoundRect(x + 0.5, y + 0.5, 0, 0, S, S, 108)) put(x, y, ...color, 1);
  }
}

// Papier met huiswerkregels.
roundRect(118, 92, 352, 404, 26, [0.97, 0.98, 1]);
const line = [0.52, 0.79, 0.94];
roundRect(152, 164, 318, 186, 11, line);
roundRect(152, 214, 318, 236, 11, line);
roundRect(152, 264, 286, 286, 11, line);
roundRect(152, 314, 252, 336, 11, line);

// Klok: symbool voor "wijziging op een tijdstip".
const clockX = 362;
const clockY = 362;
circle(clockX, clockY, 106, [1, 1, 1]);
circle(clockX, clockY, 88, [0.043, 0.369, 0.659]);
circle(clockX, clockY, 72, [1, 1, 1]);
roundRect(clockX - 7, clockY - 54, clockX + 7, clockY + 8, 7, [0.043, 0.369, 0.659]);
roundRect(clockX - 6, clockY - 7, clockX + 48, clockY + 7, 7, [0.043, 0.369, 0.659]);
circle(clockX, clockY, 10, [0.043, 0.369, 0.659]);

// --------------------------------------------------------------- downsample

function resize(size) {
  const out = Buffer.alloc(size * size * 4);
  const ratio = S / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * ratio);
      const y0 = Math.floor(y * ratio);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * ratio));
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * ratio));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * S + xx) * 4;
          r += pixels[i];
          g += pixels[i + 1];
          b += pixels[i + 2];
          a += pixels[i + 3];
          n += 1;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round((r / n) * 255);
      out[o + 1] = Math.round((g / n) * 255);
      out[o + 2] = Math.round((b / n) * 255);
      out[o + 3] = Math.round(Math.min(1, a / n) * 255);
    }
  }
  return out;
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = join(outDir, `${size}.png`);
  writeFileSync(file, encodePng(size, size, resize(size)));
  console.log(`geschreven: ${file}`);
}
