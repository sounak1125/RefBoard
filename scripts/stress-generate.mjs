#!/usr/bin/env node
/**
 * Stress-test fixture generator for RefBoard.
 *
 * Builds a real .refboard (board-save-format streaming JSON) with:
 *   - N board images (mixed small + huge) laid out in a grid
 *   - Embedded animatics project: image clips + texts + audio
 *
 * Animatics is NOT a separate importable file in the app — it only loads from
 * the board payload (`animatics` + audio/video blobs in `images[]`). This
 * script therefore emits one loadable .refboard that contains both.
 *
 * Usage:
 *   node scripts/stress-generate.mjs
 *   node scripts/stress-generate.mjs --board-images 300 --anim-clips 400 --huge 25
 *   node scripts/stress-generate.mjs --audio path/to/wavs --out stress-out
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
  animClips: 400,
  huge: 25,
  texts: 40,
  audioClips: 8,
  videoTracks: 4,
  clipDuration: 1,
  textDuration: 3,
  out: path.join(ROOT, 'stress-out'),
  audio: null,
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
      case '--anim-clips': opts.animClips = Math.max(0, Number(next()) || 0); break;
      case '--huge': opts.huge = Math.max(0, Number(next()) || 0); break;
      case '--texts': opts.texts = Math.max(0, Number(next()) || 0); break;
      case '--audio-clips': opts.audioClips = Math.max(0, Number(next()) || 0); break;
      case '--video-tracks': opts.videoTracks = Math.min(8, Math.max(1, Number(next()) || 4)); break;
      case '--clip-duration': opts.clipDuration = Math.max(1 / 60, Number(next()) || 1); break;
      case '--text-duration': opts.textDuration = Math.max(1 / 60, Number(next()) || 3); break;
      case '--out': opts.out = path.resolve(next()); break;
      case '--audio': opts.audio = path.resolve(next()); break;
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
  --anim-clips N     Animatics image clips (${DEFAULTS.animClips})
  --huge N           Huge 6000x4000 images among board set (${DEFAULTS.huge})
  --texts N          Text overlays (${DEFAULTS.texts})
  --audio-clips N    Audio clips on timeline (${DEFAULTS.audioClips})
  --video-tracks N   Video tracks 1-8 (${DEFAULTS.videoTracks})
  --clip-duration S  Image clip duration seconds (${DEFAULTS.clipDuration})
  --text-duration S  Text duration seconds (${DEFAULTS.textDuration})
  --audio DIR        Folder of real audio files (else generate WAVs)
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
function makeWavBytes({ durationSec = 2, sampleRate = 22050, freq = 440 } = {}) {
  const n = Math.max(1, Math.floor(durationSec * sampleRate));
  const dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const env = Math.min(1, t * 8) * Math.min(1, (durationSec - t) * 8);
    const sample = Math.round(Math.sin(2 * Math.PI * freq * t) * 0.35 * env * 32767);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

function wavDurationSec(buf) {
  if (buf.length < 44) return 1;
  const sampleRate = buf.readUInt32LE(24) || 22050;
  const channels = buf.readUInt16LE(22) || 1;
  const bits = buf.readUInt16LE(34) || 16;
  const dataSize = buf.readUInt32LE(40);
  const bytesPerSample = (bits / 8) * channels;
  if (!(sampleRate > 0 && bytesPerSample > 0)) return 1;
  return Math.max(1 / 60, dataSize / bytesPerSample / sampleRate);
}

async function loadAudioSources(opts, audioDir) {
  const sources = [];
  if (opts.audio) {
    const entries = await fsp.readdir(opts.audio);
    const files = entries
      .filter((n) => /\.(wav|mp3|m4a|aac|ogg|flac|opus)$/i.test(n))
      .sort()
      .slice(0, Math.max(opts.audioClips, 1));
    if (!files.length) {
      console.warn(`[warn] No audio files in ${opts.audio}; generating WAVs instead`);
    } else {
      for (const name of files) {
        const full = path.join(opts.audio, name);
        const bytes = await fsp.readFile(full);
        const ext = path.extname(name).toLowerCase();
        const type =
          ext === '.wav' ? 'audio/wav'
            : ext === '.mp3' ? 'audio/mpeg'
              : ext === '.m4a' || ext === '.aac' ? 'audio/mp4'
                : ext === '.ogg' || ext === '.opus' ? 'audio/ogg'
                  : ext === '.flac' ? 'audio/flac'
                    : 'audio/mpeg';
        let duration = ext === '.wav' ? wavDurationSec(bytes) : 3;
        sources.push({ name, bytes, type, duration, path: full });
      }
    }
  }
  while (sources.length < opts.audioClips) {
    const i = sources.length;
    const duration = 2 + (i % 3);
    const bytes = makeWavBytes({
      durationSec: duration,
      freq: 220 + i * 37,
    });
    const name = `tone-${String(i + 1).padStart(2, '0')}.wav`;
    const dest = path.join(audioDir, name);
    await fsp.writeFile(dest, bytes);
    sources.push({ name, bytes, type: 'audio/wav', duration, path: dest });
  }
  return sources.slice(0, opts.audioClips);
}

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

function buildAnimatics({ boardItems, opts, audioMeta }) {
  const tracks = opts.videoTracks;
  const clipDur = opts.clipDuration;
  const clips = [];
  for (let i = 0; i < opts.animClips; i++) {
    const item = boardItems[i % boardItems.length];
    const track = i % tracks;
    const indexOnTrack = Math.floor(i / tracks);
    const start = indexOnTrack * clipDur;
    clips.push({
      id: uid('clip', i + 1),
      itemId: item.id,
      mediaKind: 'image',
      mediaId: null,
      track,
      start,
      duration: clipDur,
      sourceIn: 0,
      sourceOut: clipDur,
      originalDuration: clipDur,
      name: item.name || `Shot ${i + 1}`,
      type: 'image/jpeg',
      enabled: true,
      framing: { fit: 'contain', scale: 1, x: 0, y: 0 },
      strokes: [],
    });
  }

  const contentEnd = Math.max(
    0,
    ...clips.map((c) => c.start + c.duration),
    opts.texts * 0.5 + opts.textDuration,
    ...audioMeta.map((a, i) => i * 1.5 + a.duration),
  );

  const texts = [];
  const colors = ['#ffffff', '#ffe08a', '#7dd3fc', '#f9a8d4', '#bbf7d0'];
  for (let i = 0; i < opts.texts; i++) {
    texts.push({
      id: uid('text', i + 1),
      track: 0,
      start: Math.max(0, (i * contentEnd) / Math.max(1, opts.texts)),
      duration: opts.textDuration,
      content: `Stress text ${i + 1}`,
      size: 28 + (i % 5) * 8,
      color: colors[i % colors.length],
      fontFamily: 'Segoe UI',
      fontStyle: 'Regular',
      fontWeight: 400,
      fontFullName: '',
      fontPostscriptName: '',
      bold: false,
      italic: false,
      align: 'center',
      background: i % 4 === 0,
      scale: 1,
      rotation: (i % 7) * 5 - 15,
      x: 0.2 + (i % 5) * 0.15,
      y: 0.25 + (i % 4) * 0.15,
    });
  }

  const audio = audioMeta.map((a, i) => {
    const duration = Math.max(1 / 60, Number(a.duration) || 2);
    return {
      id: uid('aud', i + 1),
      mediaId: a.mediaId,
      track: i % Math.min(5, Math.max(1, opts.audioClips)),
      start: i * 1.5,
      duration,
      sourceIn: 0,
      sourceOut: duration,
      originalDuration: duration,
      name: a.name,
      volume: 1,
      type: a.type,
      fadeInDuration: 0,
      fadeOutDuration: 0,
      fadeInCurve: 'constant-power',
      fadeOutCurve: 'constant-power',
      fadeInShape: 0,
      fadeOutShape: 0,
    };
  });

  const audioTracks = audio.length
    ? Math.min(5, 1 + Math.max(...audio.map((a) => a.track)))
    : 0;

  const sequenceDuration = Math.max(
    contentEnd,
    ...audio.map((a) => a.start + a.duration),
  );

  // Matches freshProject()/normalizeProject schema (version 9), serialize()-safe
  // (no blob/url fields).
  return {
    version: 9,
    fps: 30,
    resolution: 1080,
    aspect: '16:9',
    playhead: 0,
    inPoint: null,
    outPoint: null,
    sequenceDuration: Math.ceil(sequenceDuration * 30) / 30,
    timelineDisplay: 'timecode',
    timelineZoom: 90,
    timelineHeight: 286,
    inspectorWidth: 278,
    timelineSnap: true,
    timecode: false,
    counterMode: 'timecode',
    previewQuality: 'full',
    background: '#000000',
    textDefaults: {
      size: 42,
      color: '#ffffff',
      fontFamily: 'Segoe UI',
      fontStyle: 'Regular',
      fontWeight: 400,
      fontFullName: '',
      fontPostscriptName: '',
      bold: false,
      italic: false,
      align: 'center',
      background: false,
    },
    videoTracks: tracks,
    audioTracks,
    videoTrackHeights: Array.from({ length: tracks }, () => 44),
    videoTrackEnabled: Array.from({ length: tracks }, () => true),
    videoTrackLocked: Array.from({ length: tracks }, () => false),
    audioTrackHeights: Array.from({ length: audioTracks }, () => 44),
    audioTrackMuted: Array.from({ length: audioTracks }, () => false),
    audioTrackSolo: Array.from({ length: audioTracks }, () => false),
    audioTrackLocked: Array.from({ length: audioTracks }, () => false),
    textTrackLocked: false,
    clips,
    texts,
    audio,
  };
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
  const audioDir = path.join(opts.out, 'audio');
  await fsp.mkdir(imagesDir, { recursive: true });
  await fsp.mkdir(audioDir, { recursive: true });

  console.log('Generating stress fixtures…');
  console.log(`  board images: ${opts.boardImages} (${opts.huge} huge ${HUGE_W}×${HUGE_H})`);
  console.log(`  anim clips:   ${opts.animClips} across ${opts.videoTracks} tracks`);
  console.log(`  texts:        ${opts.texts}`);
  console.log(`  audio clips:  ${opts.audioClips}`);
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

  const audioSources = await loadAudioSources(opts, audioDir);
  const audioMedia = [];
  const audioMeta = [];
  let audioBytesTotal = 0;
  for (let i = 0; i < audioSources.length; i++) {
    const src = audioSources[i];
    const mediaId = uid('media-audio', i + 1);
    const dest = src.path || path.join(audioDir, src.name);
    if (!src.path) await fsp.writeFile(dest, src.bytes);
    audioBytesTotal += src.bytes.length;
    audioMedia.push({
      id: mediaId,
      type: src.type,
      name: src.name,
      w: 0,
      h: 0,
      size: src.bytes.length,
      filePath: dest,
    });
    audioMeta.push({
      mediaId,
      name: src.name,
      type: src.type,
      duration: src.duration,
    });
  }

  const animatics = buildAnimatics({ boardItems, opts, audioMeta });
  const animaticsJsonPath = path.join(opts.out, 'stress-animatics.json');
  await fsp.writeFile(animaticsJsonPath, JSON.stringify(animatics, null, 2));

  const core = {
    app: 'refboard',
    version: 3,
    view: { tx: 0, ty: 0, s: 0.15 },
    boardGray: false,
    snapEnabled: false,
    gridAppearance: 'dots',
    animatics,
    items: boardItems,
  };

  const refboardPath = path.join(opts.out, 'stress-board.refboard');
  console.log('  writing .refboard (streamed)…');
  await writeRefboard(refboardPath, core, [...imageMedia, ...audioMedia]);

  const refStat = await fsp.stat(refboardPath);
  const summary = {
    boardImages: opts.boardImages,
    hugeImages: hugeSet.size,
    animClips: animatics.clips.length,
    texts: animatics.texts.length,
    audioClips: animatics.audio.length,
    videoTracks: animatics.videoTracks,
    audioTracks: animatics.audioTracks,
    sequenceDurationSec: animatics.sequenceDuration,
    imageBytesOnDisk: imageBytesTotal,
    audioBytesOnDisk: audioBytesTotal,
    refboardBytes: refStat.size,
    paths: {
      refboard: refboardPath,
      animaticsJson: animaticsJsonPath,
      imagesDir,
      audioDir,
    },
  };
  await fsp.writeFile(
    path.join(opts.out, 'stress-summary.json'),
    JSON.stringify(summary, null, 2),
  );

  console.log('\n=== Stress fixture summary ===');
  console.log(`Images:        ${summary.boardImages} (${summary.hugeImages} huge)`);
  console.log(`Image bytes:   ${(summary.imageBytesOnDisk / 1e6).toFixed(1)} MB (loose files)`);
  console.log(`Anim clips:    ${summary.animClips}`);
  console.log(`Texts:         ${summary.texts}`);
  console.log(`Audio clips:   ${summary.audioClips} (${(summary.audioBytesOnDisk / 1e6).toFixed(2)} MB)`);
  console.log(`Sequence:      ${summary.sequenceDurationSec?.toFixed?.(1) ?? summary.sequenceDurationSec}s`);
  console.log(`Refboard size: ${(summary.refboardBytes / 1e6).toFixed(1)} MB`);
  console.log(`Output:`);
  console.log(`  ${refboardPath}`);
  console.log(`  ${animaticsJsonPath}  (embedded copy only — not separately importable)`);
  console.log(`  ${imagesDir}`);
  console.log(`  ${audioDir}`);
  if (summary.refboardBytes >= WARN_BYTES) {
    console.warn(`\n[warn] .refboard is large (${(summary.refboardBytes / 1e6).toFixed(0)} MB). Opening may take a while and use substantial RAM.`);
  }
  console.log('\nOpen in RefBoard: File / Open board → stress-board.refboard');
  console.log('Then open Animatics to stress the timeline/viewer.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
