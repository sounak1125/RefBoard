/** Focused checks for source-resolution crop/export geometry. */

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function cropOf(it) {
  const c = it.crop || {};
  const l = clamp(Number(c.l) || 0, 0, .995);
  const t = clamp(Number(c.t) || 0, 0, .995);
  const r = clamp(Number(c.r ?? 1), l + .005, 1);
  const b = clamp(Number(c.b ?? 1), t + .005, 1);
  return { l, t, r, b };
}

// Keep in sync with sourcePixelRect() in index.html.
function sourcePixelRect(im, it, useCrop) {
  if (!useCrop) return { x: 0, y: 0, w: im.w, h: im.h };
  const cr = cropOf(it);
  const x0 = clamp(Math.floor(cr.l * im.w), 0, Math.max(0, im.w - 1));
  const y0 = clamp(Math.floor(cr.t * im.h), 0, Math.max(0, im.h - 1));
  const x1 = clamp(Math.ceil(cr.r * im.w), x0 + 1, im.w);
  const y1 = clamp(Math.ceil(cr.b * im.h), y0 + 1, im.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function exportEncoding(format, sourceType) {
  if (format === 'png') return { mime: 'image/png', ext: 'png' };
  if (format === 'jpeg') return { mime: 'image/jpeg', ext: 'jpg' };
  if (format === 'webp') return { mime: 'image/webp', ext: 'webp' };
  if (sourceType === 'image/jpeg') return { mime: sourceType, ext: 'jpg' };
  if (sourceType === 'image/webp') return { mime: sourceType, ext: 'webp' };
  if (sourceType === 'image/png') return { mime: sourceType, ext: 'png' };
  return { mime: 'image/png', ext: 'png' };
}

{
  const r = sourcePixelRect({ w: 4000, h: 3000 }, { crop: { l: .1, t: .2, r: .9, b: .8 } }, true);
  assert(r.x === 400 && r.y === 600, 'crop origin uses source pixels');
  assert(r.w === 3200 && r.h === 1800, 'crop retains source resolution');
}

{
  const r = sourcePixelRect({ w: 101, h: 99 }, { crop: { l: .1, t: .1, r: .9, b: .9 } }, true);
  assert(r.x === 10 && r.y === 9, 'fractional leading edge floors outward');
  assert(r.w === 81 && r.h === 81, 'fractional trailing edge ceils outward');
}

{
  const r = sourcePixelRect({ w: 4032, h: 3024 }, { crop: { l: .25, t: .25, r: .75, b: .75 } }, false);
  assert(r.x === 0 && r.y === 0 && r.w === 4032 && r.h === 3024, 'crop-off exports full frame');
}

assert(exportEncoding('original', 'image/gif').ext === 'png', 're-encoded GIF crop uses honest PNG extension');
assert(exportEncoding('original', 'image/svg+xml').mime === 'image/png', 're-encoded SVG crop falls back to PNG');
assert(exportEncoding('original', 'image/jpeg').ext === 'jpg', 'JPEG crop preserves JPEG format');

console.log('cropped export tests passed');
