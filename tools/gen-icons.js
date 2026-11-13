// Generates the extension icons (dark rounded square with a gold Z) as raw
// PNGs using only Node's zlib. Run: node tools/gen-icons.js
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

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
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function writePng(file, size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  console.log(`wrote ${file} (${size}x${size})`);
}

const BG = [16, 24, 40]; // #101828
const FG = [245, 158, 11]; // #f59e0b

function makeIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const m = size * 0.22; // glyph margin
  const t = Math.max(1.5, size * 0.16); // stroke thickness
  const top = m, bottom = size - m, left = m, right = size - m;

  // Supersample 3x3 per pixel for smooth edges at small sizes.
  const SS = 3;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0, fgHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          // rounded-rect test
          const cx = Math.min(Math.max(fx, radius), size - radius);
          const cy = Math.min(Math.max(fy, radius), size - radius);
          if ((fx - cx) ** 2 + (fy - cy) ** 2 > radius * radius) continue;
          bgHits++;
          // Z glyph: top bar, bottom bar, diagonal from top-right to bottom-left
          const inTop = fy >= top && fy <= top + t && fx >= left && fx <= right;
          const inBottom = fy >= bottom - t && fy <= bottom && fx >= left && fx <= right;
          let inDiag = false;
          if (fy > top + t && fy < bottom - t) {
            const prog = (fy - (top + t)) / (bottom - t - (top + t));
            const centerX = right - t / 2 - prog * (right - left - t);
            inDiag = Math.abs(fx - centerX) <= t * 0.65;
          }
          if (inTop || inBottom || inDiag) fgHits++;
        }
      }
      const total = SS * SS;
      const alpha = Math.round((bgHits / total) * 255);
      const mix = bgHits ? fgHits / bgHits : 0;
      const i = (y * size + x) * 4;
      px[i] = Math.round(BG[0] + (FG[0] - BG[0]) * mix);
      px[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * mix);
      px[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * mix);
      px[i + 3] = alpha;
    }
  }
  return px;
}

const outDir = path.join(__dirname, "..", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  writePng(path.join(outDir, `icon${size}.png`), size, makeIcon(size));
}
