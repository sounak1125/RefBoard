/**
 * The Viewer / PDF board export, pure parts:
 *   - payload building (images, notes, annotations, groups, labels)
 *   - escaping into the page (the </script> and onerror= notes stay data)
 *   - the link-scheme whitelist
 *   - the size estimate
 *   - long-edge resize maths (never upscales)
 *   - PDF page scale and size, small boards and boards past 200 in
 * The rendered page itself is covered by scripts/smoke-board-viewer.mjs.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  buildViewerPayload,
  cmdsToSvgPath,
  estimateExportBytes,
  fitLongEdge,
  formatBytes,
  safeLinkHref,
  viewerLongEdge,
  VIEWER_BOARD_PAD,
} from './board-viewer-payload.mjs';
import {
  annotationHaloColor,
  arrowBounds,
  arrowGeometry,
  highlighterWidth,
  inkStrokeOutline,
  smoothPolyline,
  tubeOutline,
} from './annotation-geometry.mjs';
import { parseNoteLine, parseNoteLinkSegments } from './note-dom.mjs';

const require = createRequire(import.meta.url);
const {
  PDF_MAX_CSS_PX, pdfPageLayout, escapeJsonForScript, assembleViewerHtml, viewerImageBlock, validatePayload,
} = require('./board-export-main.js');

const template = await readFile(new URL('./board-viewer-template.html', import.meta.url), 'utf8');
const runtime = await readFile(new URL('./board-viewer-runtime.js', import.meta.url), 'utf8');

/* ---------------- link whitelist ---------------- */
for (const ok of ['https://example.com/a?b=1#c', 'http://example.com', 'HTTPS://EXAMPLE.COM/x', 'mailto:someone@example.com']) {
  assert.ok(safeLinkHref(ok), `${ok} is allowed`);
}
assert.equal(safeLinkHref(' https://example.com/x '), 'https://example.com/x', 'surrounding space is trimmed');
for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:msgbox', 'file:///C:/Windows',
  'blob:https://example.com/1', '//example.com', '/relative', 'www.example.com', 'java\nscript:alert(1)', 'https:\u0000//x', '', null, 'http://']) {
  assert.equal(safeLinkHref(bad), null, `${JSON.stringify(bad)} is refused`);
}

/* ---------------- long edge ---------------- */
assert.deepEqual(fitLongEdge(4000, 3000, 2048), { w: 2048, h: 1536, scaled: true });
assert.deepEqual(fitLongEdge(3000, 4000, 1024), { w: 768, h: 1024, scaled: true });
assert.deepEqual(fitLongEdge(1000, 800, 2048), { w: 1000, h: 800, scaled: false }, 'smaller than the edge: never upscaled');
assert.deepEqual(fitLongEdge(2048, 10, 2048), { w: 2048, h: 10, scaled: false }, 'exactly the edge is not a resize');
assert.deepEqual(fitLongEdge(5000, 5000, 0), { w: 5000, h: 5000, scaled: false }, 'Original (0) keeps the size');
assert.deepEqual(fitLongEdge(1, 100000, 1024), { w: 1, h: 1024, scaled: true }, 'a sliver keeps at least one pixel');
assert.equal(viewerLongEdge('original'), 0);
assert.equal(viewerLongEdge('2048'), 2048);
assert.equal(viewerLongEdge('1024'), 1024);
assert.equal(viewerLongEdge('512'), 0, 'an unknown size falls back to Original');
for (const [w, h, max] of [[7952, 5304, 2048], [5304, 7952, 1024], [3001, 2999, 2048]]) {
  const r = fitLongEdge(w, h, max);
  assert.equal(Math.max(r.w, r.h), max, `${w}x${h} -> long edge ${max}`);
  assert.ok(Math.abs(r.w / r.h - w / h) < 0.01, 'aspect ratio kept');
}

/* ---------------- PDF page ---------------- */
{
  const small = pdfPageLayout(800, 600);
  assert.equal(small.scale, 1, 'a small board prints at 1:1');
  assert.deepEqual([small.wPx, small.hPx, small.wPt, small.hPt], [800, 600, 600, 450]);
  const big = pdfPageLayout(30000, 10000);
  assert.equal(big.wPx, PDF_MAX_CSS_PX, 'a board past 200 in is scaled to 200 in');
  assert.equal(big.wPt, 14400, '200 in is 14,400 pt');
  assert.equal(big.hPx, 6400, 'its height scales with it');
  assert.ok(Math.abs(big.scale - 0.64) < 1e-9);
  const tall = pdfPageLayout(1200, 50000);
  assert.equal(tall.hPt, 14400, 'a tall board is capped on its height');
  assert.equal(tall.wPx, Math.round(1200 * 19200 / 50000));
  const edge = pdfPageLayout(19200, 100);
  assert.equal(edge.scale, 1, 'exactly 200 in is not scaled');
  assert.ok(pdfPageLayout(1e6, 1e6).wPt <= 14400 && pdfPageLayout(1e6, 1e6).hPt <= 14400);
  assert.equal(pdfPageLayout(0.2, 0.2).wPx, 1, 'never a zero-size page');
}

/* ---------------- SVG paths from canvas commands ---------------- */
{
  const circle = cmdsToSvgPath([['M', 15, 10], ['A', 10, 10, 5, 0, Math.PI * 2, false], ['Z']]);
  assert.equal((circle.match(/A/g) || []).length, 2, 'a full circle becomes two arcs');
  assert.match(circle, /^M15 10L15 10A5 5 0 0 1 5 10A5 5 0 0 1 15 10Z$/);
  const tube = cmdsToSvgPath(tubeOutline([0, 0, 50, 0, 100, 20], [2, 3, 4]));
  assert.match(tube, /^M[-\d.]+ [-\d.]+/);
  assert.ok(!/NaN|Infinity|undefined/.test(tube), 'no broken numbers');
  assert.ok(tube.includes('A4 4 0 0 0'), 'the end cap is an anticlockwise half circle (sweep 0)');
}

/* ---------------- payload ---------------- */
const XSS = '</script><script>alert(1)</script>';
const ONERR = '<img src=x onerror="alert(2)">';
const items = [
  { id: 'g1', kind: 'group', x: 0, y: 0, w: 10, h: 10, color: '#ff6b6b', name: 'Mood <b>', locked: false },
  { id: 'a', kind: 'image', imgId: 'ia', x: 0, y: 0, w: 400, h: 300, crop: { l: 0.1, t: 0.2, r: 0.9, b: 1 }, groupId: 'g1', tags: ['Warm', 'sky'] },
  { id: 'b', kind: 'image', imgId: 'ib', x: 500, y: 0, w: 300, h: 300, rot: 30, flipX: true, gray: true, tags: ['warm'] },
  { id: 'n', kind: 'note', x: 0, y: 400, w: 300, h: 120, color: '#ffd166', textColor: '#15161c', fontFamily: 'Georgia"; } body{', bold: true,
    textAlign: 'center', text: `[x] done [site](https://example.com/a)\n- ${XSS}\n2. ${ONERR}\n[bad](javascript:alert(3)) mailto:x is plain`, tags: ['sky'] },
  { id: 'r', kind: 'arrow', x1: 0, y1: 0, x2: 200, y2: 100, strokeWidth: 4, color: '#ff4d4f', heads: 'end' },
  { id: 'd', kind: 'arrow', x1: 0, y1: 0, x2: 200, y2: 0, strokeWidth: 3, color: '#ffffff', arrowStyle: 'dotted', heads: 'both', outline: false },
  { id: 'k', kind: 'ink', x: 100, y: 100, w: 60, h: 40, bw: 30, bh: 20, rot: 0, inkStyle: 'pen', size: 3, color: '#2fd28a', strokes: [[0, 0, 0.5, 10, 10, 0.7, 30, 20, 0.4]] },
  { id: 'h', kind: 'ink', x: 0, y: 0, w: 50, h: 50, bw: 50, bh: 50, inkStyle: 'highlighter', size: 12, color: '#ffd60a', strokes: [[0, 0, 1, 50, 50, 1]] },
];
const helpers = {
  imageRef: it => (it.imgId === 'ia' ? { img: 0, crop: [0.1, 0.2, 0.9, 1] } : { img: 1, crop: [0, 0, 1, 1] }),
  images: [{ mime: 'image/jpeg', w: 2048, h: 1536, name: 'a.jpg' }, { mime: 'image/webp', w: 512, h: 512, name: 'b.png' }],
  noteMetrics: () => ({ eff: 15, lineH: 21.75, padX: 10, padY: 7, gutter: 20.25 }),
  groupBox: () => ({ x: 0, y: 0, w: 400, h: 300 }),
  groupKids: () => ['a'],
  boundsOf: it => ({ x: it.x, y: it.y, w: it.w, h: it.h }),
  arrowGeometry, arrowBounds, smoothPolyline, inkStrokeOutline, highlighterWidth, annotationHaloColor,
  parseNoteLine, parseNoteLinkSegments,
};
const board = { name: `Board ${XSS}`, background: '#141a24', gray: false, tagColors: { warm: '#ff9f6b' } };
const payload = buildViewerPayload({ items, options: { notes: true, labels: true, allowSave: false }, board, helpers });

assert.equal(payload.v, 1);
assert.deepEqual(payload.items.map(i => i.t), ['group', 'img', 'img', 'note', 'arrow', 'arrow', 'ink', 'ink'],
  'board draw order: groups, images, notes, annotations');
const [group, imgA, imgB, note] = payload.items;
assert.deepEqual(imgA.crop, [0.1, 0.2, 0.9, 1]);
assert.equal(imgB.rot, 30);
assert.equal(imgB.fx, 1);
assert.equal(imgB.gray, 1);
assert.equal(imgB.fy, undefined);
assert.deepEqual(group.kids, ['a']);
assert.equal(group.name, 'Mood <b>', 'group names stay text (escaped later, never markup)');
assert.equal(note.family, 'Georgia; } body{', 'quotes and backslashes cannot leave the font-family string');
assert.equal(note.align, 'center');
assert.equal(note.bold, 1);
assert.deepEqual(note.lines.map(l => l.k), ['check', 'bullet', 'number', 'plain']);
assert.equal(note.lines[0].checked, true);
assert.deepEqual(note.lines[0].segs, [{ text: 'done ' }, { text: 'site', href: 'https://example.com/a' }]);
assert.equal(note.lines[1].segs[0].text, XSS, 'the </script> note is carried as text');
assert.equal(note.lines[2].n, 2);
assert.equal(note.lines[2].segs[0].text, ONERR, 'the onerror note is carried as text');
assert.deepEqual(note.lines[3].segs[0], { text: 'bad' }, 'a javascript: link keeps its label and loses its href');
assert.ok(!JSON.stringify(payload).includes('javascript:alert(3)'), 'the refused URL is not in the payload at all');
// Labels: case-insensitive, counted once per item, coloured from the board.
assert.deepEqual(payload.tags, [{ name: 'Warm', count: 2, color: '#ff9f6b' }, { name: 'sky', count: 2 }]);
assert.deepEqual(imgA.tags, [0, 1]);
assert.deepEqual(imgB.tags, [0]);
assert.deepEqual(note.tags, [1]);
// Annotations are SVG paths with the board's geometry.
const solid = payload.items[4];
assert.ok(solid.paths.some(p => p.fill === '#ff4d4f'), 'the arrow is filled in its colour');
assert.ok(solid.paths.some(p => p.stroke === annotationHaloColor('#ff4d4f')), 'with its contrast outline');
const ab = arrowBounds(items[4], 4 * 1.1);
assert.deepEqual([solid.x, solid.y, solid.w, solid.h].map(Math.round), [ab.x, ab.y, ab.w, ab.h].map(Math.round));
const dotted = payload.items[5];
assert.ok(dotted.paths.some(p => p.dash), 'a dotted arrow is a dashed stroke');
assert.ok(!dotted.paths.some(p => p.stroke === annotationHaloColor('#ffffff')), 'outline off: no halo');
const pen = payload.items[6];
assert.equal(pen.bw, 30);
assert.ok(pen.paths.some(p => p.fill === '#2fd28a') && pen.paths.some(p => p.stroke), 'pen ink: halo stroke and filled nib');
const hl = payload.items[7];
assert.equal(hl.highlighter, true);
assert.equal(hl.paths[0].width, 12);
for (const it of payload.items.filter(i => i.paths)) {
  for (const p of it.paths) assert.ok(/^M/.test(p.d) && !/NaN|undefined/.test(p.d), 'every path is valid path data');
}
// Bounds: the items' extent padded like the PNG export.
assert.equal(payload.bounds.x, Math.min(...[0, solid.x, 0]) - VIEWER_BOARD_PAD);
assert.ok(payload.bounds.w > 800 && payload.bounds.h > 520);

const noNotes = buildViewerPayload({ items, options: { notes: false, labels: false, allowSave: true }, board, helpers });
assert.deepEqual(noNotes.items.map(i => i.t), ['group', 'img', 'img'], 'notes and annotations off: images and groups only');
assert.deepEqual(noNotes.tags, [], 'labels off: no label panel');
assert.equal(noNotes.items[1].tags, undefined, 'labels off: no item tags');
assert.equal(noNotes.allowSave, 1);
assert.equal(buildViewerPayload({ items, options: {}, board: { background: 'red;}' }, helpers }).bg, '#141a24',
  'a colour that is not a hex colour falls back');

/* ---------------- escaping into the page ---------------- */
const fakeImages = [{ mime: 'image/jpeg', base64: Buffer.from('jpeg-bytes').toString('base64') }, { mime: 'image/webp', base64: 'AAAA' }];
const html = assembleViewerHtml({ template, runtime, title: board.name, payload, images: fakeImages });
assert.equal((html.match(/<script\b/gi) || []).length, 4, 'exactly two image blocks, the payload and the runtime');
assert.equal((html.match(/<\/script>/gi) || []).length, 4, 'no extra closing script tag from user text');
assert.ok(!html.includes('alert(1)</script>'), 'the </script> note cannot close a script element');
assert.ok(!html.includes('<img src=x'), 'the onerror note never appears as markup');
assert.match(html, /<title>Board &lt;\/script&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/, 'the title is escaped text');
const json = html.match(/<script type="application\/json" id="rb-payload">([^<]*)<\/script>/);
assert.ok(json, 'the payload script holds no < at all');
assert.deepEqual(JSON.parse(json[1]), JSON.parse(JSON.stringify(payload)), 'the escaped payload parses back to the same data');
assert.ok(!escapeJsonForScript({ a: '<!--<script>' }).includes('<'));
assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline';/);
assert.ok(!/<\/script|<script|<!--/i.test(runtime), 'the runtime has no script tags or comment openers of its own (they change how a script element parses)');
assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts|<link\b|@import/.test(runtime + template),
  'the runtime and template reach for no network API');
assert.throws(() => viewerImageBlock(0, 'text/html', 'AAAA'), /unsupported image type/);
assert.throws(() => viewerImageBlock(0, 'image/png', 'AA"><script>'), /not base64/);
assert.throws(() => viewerImageBlock(-1, 'image/png', 'AAAA'), /bad image index/);
assert.throws(() => validatePayload({ ...payload, bg: 'red;}' }, 2), /bad board colour/);
assert.throws(() => validatePayload(payload, 3), /lists 2 images, received 3/);
validatePayload(payload, 2);

/* ---------------- size estimate ---------------- */
{
  const photo = { bytes: 6_000_000, mime: 'image/jpeg', outW: 6000, outH: 4000, passthrough: true };
  const orig = estimateExportBytes({ plan: [photo], kind: 'viewer', payloadBytes: 1000, runtimeBytes: 30000 });
  assert.equal(orig, Math.ceil(6_000_000 / 3) * 4 + 96 + 1000 + 30000, 'Original counts the real bytes as base64');
  const at2048 = estimateExportBytes({ plan: [{ ...photo, passthrough: false, outW: 2048, outH: 1365, srcPx: 24e6 }], kind: 'viewer' });
  const at1024 = estimateExportBytes({ plan: [{ ...photo, passthrough: false, outW: 1024, outH: 683, srcPx: 24e6 }], kind: 'viewer' });
  assert.ok(at1024 < at2048 && at2048 < orig, `1024 (${at1024}) < 2048 (${at2048}) < Original (${orig})`);
  assert.ok(at2048 > 2048 * 1365 * 0.15 * 4 / 3 && at2048 < 2048 * 1365 * 0.4 * 4 / 3, 'a 2048 px JPEG lands at a plausible size');
  // A smooth image that compresses far better than a photo: estimated from its own density.
  const smooth = { bytes: 200_000, mime: 'image/jpeg', outW: 2048, outH: 1365, passthrough: false, srcPx: 6e6 };
  const smoothEst = estimateExportBytes({ plan: [smooth], kind: 'viewer', runtimeBytes: 0 });
  assert.ok(smoothEst < Math.ceil(200_000 / 3) * 4, `re-encoding a smooth 6 MP JPEG to 2048 px never estimates above its own file (${smoothEst})`);
  const cropHalf = estimateExportBytes({ plan: [{ ...smooth, outW: 1000, outH: 1000, rectPx: 1e6 }], kind: 'viewer', runtimeBytes: 0 });
  assert.ok(cropHalf < smoothEst, 'a crop counts only the source pixels it covers');
  const origCrop = estimateExportBytes({ plan: [{ bytes: 1_200_000, mime: 'image/png', outW: 1200, outH: 800, passthrough: false, original: true, srcPx: 2400 * 1600, rectPx: 1200 * 800 }], kind: 'viewer', runtimeBytes: 0 });
  assert.equal(origCrop, Math.ceil(300_000 / 3) * 4 + 96, 'a crop at Original counts its share of the source bytes');
  const alpha = estimateExportBytes({ plan: [{ bytes: 1, mime: 'image/png', outW: 1000, outH: 1000, passthrough: false }], kind: 'viewer', runtimeBytes: 0 });
  const opaque = estimateExportBytes({ plan: [{ bytes: 1, mime: 'image/jpeg', outW: 1000, outH: 1000, passthrough: false }], kind: 'viewer', runtimeBytes: 0 });
  assert.ok(alpha > opaque, 'images that may carry alpha estimate larger');
  const pdfJpeg = estimateExportBytes({ plan: [photo], kind: 'pdf' });
  const pdfPng = estimateExportBytes({ plan: [{ bytes: 500_000, mime: 'image/png', outW: 1000, outH: 1000, passthrough: true }], kind: 'pdf' });
  assert.ok(pdfJpeg < orig, 'the PDF keeps JPEG bytes as they are (no base64)');
  assert.equal(pdfPng, Math.round(500_000 * 1.2 + 8 * 1024), 'the PDF stores non-JPEG images deflated, about their file size');
  const pdfFlat = estimateExportBytes({ plan: [{ bytes: 50_000_000, mime: 'image/png', outW: 1000, outH: 1000, passthrough: true }], kind: 'pdf' });
  assert.equal(pdfFlat, Math.round(1000 * 1000 * 1.6 + 8 * 1024), 'but never more than raw-ish pixels');
  assert.equal(estimateExportBytes({ plan: [], kind: 'viewer', payloadBytes: 10, runtimeBytes: 5 }), 15);
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536 * 1024), '1.5 MB');
  assert.equal(formatBytes(150 * 1024 * 1024), '150 MB');
}

console.log('board viewer tests passed — payload, escaping (</script>, onerror), link whitelist, size estimate, long-edge maths, PDF page size');
