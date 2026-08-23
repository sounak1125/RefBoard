#!/usr/bin/env node
/**
 * Stress-test fixture generator for RefBoard.
 *
 * Builds a real .refboard (board-save-format streaming JSON) with:
 *   - N board images (mixed small + huge) laid out in a grid
 *
 * Usage:
 *   node scripts/stress-generate.mjs
 *   node scripts/stress-generate.mjs --board-images 2000 --huge 25
 *   node scripts/stress-generate.mjs --board-images 500 --out stress-out
 *
 * Then in RefBoard: Open → pick stress-out/stress-board.refboard
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const { boardHeaderPrefix, boardImageParts } = require('./board-save-format.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  boardImages: 300,
  huge: 25,
  out: path.join(ROOT, 'stress-out'),
};

const HUGE_W = 6000;
const HUGE_H = 4000;
const SMALL_SIZE = 256;
const DISPLAY_MAX = 280;
const GRID_GAP = 24;
const WARN_BYTES = 400 * 1024 * 1024;

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null || v.startsWith('--')) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case '--board-images': opts.boardImages = Math.max(1, Number(next()) || DEFAULTS.boardImages); break;
      case '--huge': opts.huge = Math.max(0, Number(next()) || 0); break;
      case '--out': opts.out = path.resolve(next()); break;
      case '--help': case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown arg: ${a}`);
    }
  }
  opts.huge = Math.min(opts.huge, opts.boardImages);
  return opts;
}

function printHelp() {
  console.log(`RefBoard stress fixture generator

Options (defaults in parentheses):
  --board-images N   Board image count (${DEFAULTS.boardImages})
  --huge N           Huge 6000x4000 images among board set (${DEFAULTS.huge})
  --out DIR          Output directory (${DEFAULTS.out})
`);
}

function uid(prefix, i) {
  return `${prefix}-${String(i).padStart(4, '0')}`;
}

function hslColor(i, total) {
  const h = Math.round((i * 360) / Math.max(1, total));
  return { h, s: 55 + (i % 30), l: 40 + (i % 25) };
}

async function makeImageBuffer({ index, total, huge, label }) {
  const { h, s, l } = hslColor(index, total);
  const w = huge ? HUGE_W : SMALL_SIZE;
  const ht = huge ? HUGE_H : SMALL_SIZE;

  if (huge) {
    // Small noise tile → upscale. Keeps JPEG multi-MB without a 72MB JS fill loop.
    const tw = 512;
    const th = 512;
    const tile = Buffer.alloc(tw * th * 3);
    let seed = (index + 1) * 2654435761 >>> 0;
    const view = new Uint32Array(tile.buffer, tile.byteOffset, Math.floor(tile.byteLength / 4));
    for (let i = 0; i < view.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      view[i] = seed;
    }
    const tintR = Math.round((h / 360) * 90 + 40);
    const tintG = Math.round((s / 100) * 90 + 40);
    const tintB = Math.round((l / 100) * 90 + 40);
    const labeled = await sharp(tile, { raw: { width: tw, height: th, channels: 3 } })
      .resize(w, ht, { kernel: 'nearest' })
      .modulate({ brightness: 1, saturation: 1.05 })
      .composite([
        {
          input: {
            create: {
              width: w,
              height: Math.round(ht * 0.18),
              channels: 4,
              background: { r: 0, g: 0, b: 0, alpha: 0.45 },
            },
          },
          top: Math.round(ht * 0.41),
          left: 0,
        },
        {
          input: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${ht}">
  <rect x="0" y="0" width="120" height="120" fill="rgb(${tintR},${tintG},${tintB})"/>
  <text x="50%" y="48%" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="180" font-weight="700" fill="white">${escapeXml(label)}</text>
  <text x="50%" y="56%" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="96" fill="rgba(255,255,255,0.9)">${w}×${ht} HUGE</text>
</svg>`),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return {
      bytes: labeled.data,
      w: labeled.info.width,
      h: labeled.info.height,
      type: 'image/jpeg',
      size: labeled.data.length,
    };
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${ht}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${h} ${s}% ${l}%)"/>
      <stop offset="100%" stop-color="hsl(${(h + 40) % 360} ${s}% ${Math.max(20, l - 15)}%)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect x="4%" y="4%" width="92%" height="92%" fill="none" stroke="white" stroke-width="4" opacity="0.35"/>
  <text x="50%" y="48%" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="28" font-weight="700" fill="white">${escapeXml(label)}</text>
  <text x="50%" y="58%" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif"
        font-size="16" fill="rgba(255,255,255,0.85)">${w}×${ht}</text>
</svg>`;
  const { data, info } = await sharp(Buffer.from(svg))
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return {
    bytes: data,
    w: info.width,
    h: info.height,
    type: 'image/jpeg',
    size: data.length,
  };
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Minimal PCM WAV (mono 16-bit). */
function displaySize(pw, ph) {
  const k = Math.min(1, DISPLAY_MAX / Math.max(pw, ph));
  return {
    w: Math.max(4, Math.round(pw * k)),
    h: Math.max(4, Math.round(ph * k)),
  };
}

function layoutGrid(items) {
  const n = items.length;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  let x = 0;
  let y = 0;
  let rowH = 0;
  let col = 0;
  for (const it of items) {
    if (col >= cols) {
      x = 0;
      y += rowH + GRID_GAP;
      rowH = 0;
      col = 0;
    }
    it.x = x;
    it.y = y;
    x += it.w + GRID_GAP;
    rowH = Math.max(rowH, it.h);
    col++;
  }
}

async function writeRefboard(outPath, core, mediaRecords) {
  const stream = fs.createWriteStream(outPath, { encoding: 'utf8' });
  stream.write(boardHeaderPrefix(core, null));
  let first = true;
  for (const rec of mediaRecords) {
    const bytes = rec.bytes || await fsp.readFile(rec.filePath);
    const parts = boardImageParts(
      {
        id: rec.id,
        type: rec.type,
        name: rec.name,
        w: rec.w || 0,
        h: rec.h || 0,
        size: rec.size || bytes.length,
      },
      bytes,
    );
    if (!first) stream.write(',');
    first = false;
    stream.write(parts.prefix);
    stream.write(parts.base64);
    stream.write(parts.suffix);
  }
  stream.write(']}');
  stream.end();
  await finished(stream);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const imagesDir = path.join(opts.out, 'images');
  await fsp.mkdir(imagesDir, { recursive: true });

  console.log('Generating stress fixtures…');
  console.log(`  board images: ${opts.boardImages} (${opts.huge} huge ${HUGE_W}×${HUGE_H})`);
  console.log(`  out:          ${opts.out}`);

  const boardItems = [];
  const imageMedia = [];
  let imageBytesTotal = 0;

  // Mark first `huge` indices as huge (spread: every Nth if wanted — contiguous is fine)
  const hugeSet = new Set();
  for (let i = 0; i < opts.huge; i++) {
    // Spread huge images through the set so they aren't all clustered.
    const idx = opts.boardImages <= opts.huge
      ? i
      : Math.floor((i * opts.boardImages) / opts.huge);
    hugeSet.add(Math.min(opts.boardImages - 1, idx));
  }

  for (let i = 0; i < opts.boardImages; i++) {
    const huge = hugeSet.has(i);
    const imgId = uid('img', i + 1);
    const itemId = uid('item', i + 1);
    const label = huge ? `H${i + 1}` : `#${i + 1}`;
    process.stdout.write(`\r  images ${i + 1}/${opts.boardImages}${huge ? ' (huge)' : '       '}`);
    const made = await makeImageBuffer({
      index: i,
      total: opts.boardImages,
      huge,
      label,
    });
    const fileName = `${imgId}${huge ? '-huge' : ''}.jpg`;
    const filePath = path.join(imagesDir, fileName);
    await fsp.writeFile(filePath, made.bytes);
    imageBytesTotal += made.bytes.length;

    imageMedia.push({
      id: imgId,
      type: made.type,
      name: fileName,
      w: made.w,
      h: made.h,
      size: made.size,
      filePath, // read back when streaming .refboard (keeps peak RAM down)
    });

    const disp = displaySize(made.w, made.h);
    boardItems.push({
      id: itemId,
      kind: 'image',
      imgId,
      name: fileName,
      x: 0,
      y: 0,
      w: disp.w,
      h: disp.h,
      rot: 0,
      flipX: false,
      flipY: false,
      gray: false,
      crop: { l: 0, t: 0, r: 1, b: 1 },
      groupId: null,
    });
  }
  process.stdout.write('\n');
  layoutGrid(boardItems);

  const core = {
    app: 'refboard',
    version: 3,
    view: { tx: 0, ty: 0, s: 0.15 },
    boardGray: false,
    snapEnabled: false,
    gridAppearance: 'dots',
    items: boardItems,
  };

  const refboardPath = path.join(opts.out, 'stress-board.refboard');
  console.log('  writing .refboard (streamed)…');
  await writeRefboard(refboardPath, core, imageMedia);

  const refStat = await fsp.stat(refboardPath);
  const summary = {
    boardImages: opts.boardImages,
    hugeImages: hugeSet.size,
    imageBytesOnDisk: imageBytesTotal,
    refboardBytes: refStat.size,
    paths: {
      refboard: refboardPath,
      imagesDir,
    },
  };
  await fsp.writeFile(
    path.join(opts.out, 'stress-summary.json'),
    JSON.stringify(summary, null, 2),
  );

  console.log('\n=== Stress fixture summary ===');
  console.log(`Images:        ${summary.boardImages} (${summary.hugeImages} huge)`);
  console.log(`Image bytes:   ${(summary.imageBytesOnDisk / 1e6).toFixed(1)} MB (loose files)`);
  console.log(`Refboard size: ${(summary.refboardBytes / 1e6).toFixed(1)} MB`);
  console.log(`Output:`);
  console.log(`  ${refboardPath}`);
  console.log(`  ${imagesDir}`);
  if (summary.refboardBytes >= WARN_BYTES) {
    console.warn(`\n[warn] .refboard is large (${(summary.refboardBytes / 1e6).toFixed(0)} MB). Opening may take a while and use substantial RAM.`);
  }
  console.log('\nOpen in RefBoard: File / Open board → stress-board.refboard');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
