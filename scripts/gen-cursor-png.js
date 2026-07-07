'use strict';
const zlib = require('zlib');

const W = 32;
const H = 32;

function crc32(buf) {
  let c = 0xffffffff;
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c2 = n;
    for (let k = 0; k < 8; k++) c2 = (c2 & 1) ? (0xedb88320 ^ (c2 >>> 1)) : (c2 >>> 1);
    table[n] = c2;
  }
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 1);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeB = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeB, data])));
  return Buffer.concat([len, typeB, data, crc]);
}

const verts = [
  [2, 2], [2, 18], [6, 14], [8.5, 20], [11, 19], [8.5, 13], [13, 13],
].map(([x, y]) => [x * (W / 22), y * (H / 22)]);

function inPoly(x, y) {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const [xi, yi] = verts[i];
    const [xj, yj] = verts[j];
    const intersect = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy + 1e-9)));
  const nx = x1 + t * dx;
  const ny = y1 + t * dy;
  return Math.hypot(px - nx, py - ny);
}

function edgeDist(x, y) {
  let min = Infinity;
  for (let i = 0; i < verts.length; i++) {
    const [x1, y1] = verts[i];
    const [x2, y2] = verts[(i + 1) % verts.length];
    min = Math.min(min, distSeg(x, y, x1, y1, x2, y2));
  }
  return min;
}

const rgba = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const cx = x + 0.5;
    const cy = y + 0.5;
    const fill = inPoly(cx, cy);
    const edge = edgeDist(cx, cy);
    const stroke = fill && edge < 1.35;
    const i = (y * W + x) * 4;
    if (stroke) {
      rgba[i] = 0x15; rgba[i + 1] = 0x16; rgba[i + 2] = 0x1c; rgba[i + 3] = 255;
    } else if (fill) {
      rgba[i] = 0xf2; rgba[i + 1] = 0xf4; rgba[i + 2] = 0xf8; rgba[i + 3] = 255;
    }
  }
}

const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  const row = y * (W * 4 + 1);
  raw[row] = 0;
  Buffer.from(rgba.subarray(y * W * 4, (y + 1) * W * 4)).copy(raw, row + 1);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const b64 = png.toString('base64');
const tailBytes = png.slice(-12);
const ok = tailBytes[4] === 0x49 && tailBytes[5] === 0x45 && tailBytes[6] === 0x4e && tailBytes[7] === 0x44;
if (!ok) {
  console.error('Invalid PNG IEND bytes', tailBytes.toString('hex'));
  process.exit(1);
}
require('fs').writeFileSync(require('path').join(__dirname, 'cursor-test.png'), png);
console.log(`url("data:image/png;base64,${b64}") 2 2, default`);
