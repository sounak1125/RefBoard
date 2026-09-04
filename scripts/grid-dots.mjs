/**
 * The board's dot grid as one pattern fill.
 *
 * It used to be one 1x1 fillRect per dot on a 10 screen-px pitch: about 20,000
 * canvas calls per frame on a 1080p viewport, during pan and zoom included, and
 * unrelated to how many images the board holds. This draws the same dots with
 * a single fill of a repeating tile.
 *
 * The dots must not change appearance. The old loop placed each dot at
 * round(k * step + tx) + 0.5 in CSS px under the device-pixel-ratio transform,
 * so its anti-aliasing depended on the pan offset and, at fractional ratios, on
 * which dot it was. Two things reproduce that exactly:
 *
 *  - The tile edge is a whole number of device pixels (`tileRepeat` picks how
 *    many dots wide it has to be for that), so repeating it never resamples.
 *  - The pan phase is baked into the tile rather than applied as a translate,
 *    because a fractional device-pixel translate of a pattern is a resample.
 *    The phase only takes step^2 distinct values, so the tiles are cached.
 */
const patterns = new Map();
const MAX_CACHED_PATTERNS = 160;

/** Smallest number of dots per tile edge that lands on whole device pixels. */
export function tileRepeat(step, dpr) {
  for (let k = 1; k <= 8; k++) {
    const edge = step * dpr * k;
    if (Math.abs(edge - Math.round(edge)) < 1e-6) return k;
  }
  return 8;
}

/** Pan offset reduced to the dot phase in [0, step), rounded as the loop did. */
export function gridPhase(t, step) {
  return ((Math.round(t) % step) + step) % step;
}

export function gridDotPattern(g, { step, color, dpr, ox = 0, oy = 0 }) {
  const key = `${step}|${dpr}|${color}|${ox}|${oy}`;
  let pattern = patterns.get(key);
  if (pattern) return pattern;
  const k = tileRepeat(step, dpr);
  const tileCss = step * k;
  const tile = document.createElement('canvas');
  tile.width = tile.height = Math.round(tileCss * dpr);
  const tg = tile.getContext('2d');
  tg.setTransform(dpr, 0, 0, dpr, 0, 0);
  tg.fillStyle = color;
  for (let i = 0; i < k; i++) {
    const x = (ox + i * step) % tileCss;
    for (let j = 0; j < k; j++) {
      const y = (oy + j * step) % tileCss;
      // A dot at phase step-1 spans the tile edge (9.5..10.5 in a 10px tile).
      // Draw its wrapped copies too; the ones off the tile cost nothing.
      for (const wx of [x, x - tileCss]) {
        for (const wy of [y, y - tileCss]) tg.fillRect(wx + 0.5, wy + 0.5, 1, 1);
      }
    }
  }
  pattern = g.createPattern(tile, 'repeat');
  // The tile is device pixels; the fill happens in CSS px under the DPR transform.
  pattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
  if (patterns.size >= MAX_CACHED_PATTERNS) patterns.delete(patterns.keys().next().value);
  patterns.set(key, pattern);
  return pattern;
}

/**
 * Fill the screen-space rect (x, y, w, h) with the dot grid for view offset
 * (tx, ty). `g` must already carry the DPR transform, as the board context does.
 */
export function drawGridDots(g, { x, y, w, h, tx, ty, step, color, dpr }) {
  if (!(w > 0 && h > 0)) return;
  const pattern = gridDotPattern(g, {
    step, color, dpr, ox: gridPhase(tx, step), oy: gridPhase(ty, step),
  });
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.fillStyle = pattern;
  // Overfill and let the clip cut the edge, as the loop did: a dot straddling
  // the boundary is clipped once, not attenuated by a second fill edge.
  g.fillRect(x - step, y - step, w + step * 2, h + step * 2);
  g.restore();
}

/** Test hook. */
export function clearGridDotPatternCache() {
  patterns.clear();
}
