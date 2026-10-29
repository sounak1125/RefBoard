/* Content-aware fill geometry, in source-image pixels.
 *
 * The model sees a fixed 512x512 square. The region it gets is the hole plus
 * context around it: the lasso grown by about 1.56% of the image's long side,
 * then a 196 px margin, made square and at least 512 px, slid inside the
 * image. The crop matches scripts/inpaint-bakeoff/onnx-engines.py, which
 * produced the numbers the engine was chosen on.
 *
 * The growth matters because LaMa regrows anything the lasso misses. The
 * bake-off grew masks 1.1% with a square kernel, which reaches 1.1% x sqrt(2)
 * along a diagonal; growing round by just 1.1% left a shoulder pad that poked
 * out of a tight lasso to come back as a dark blob, so the round growth takes
 * the square kernel's full reach.
 */

export const INPAINT_INPUT = 512;
export const INPAINT_MARGIN = 196;
export const INPAINT_GROW = 0.011 * Math.SQRT2;
export const INPAINT_MIN_LASSO_AREA = 16;

/** How far the drawn lasso is grown before filling, in image pixels. */
export function inpaintGrowPx(width, height) {
  return Math.max(2, Math.round(INPAINT_GROW * Math.max(width, height)));
}

/** Shoelace area of a closed polygon given as [[x, y], ...]. */
export function polygonArea(points) {
  let sum = 0;
  for (let i = 0, n = points.length; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** A lasso worth filling: enough points and enough area to be a deliberate selection. */
export function isUsableLasso(points) {
  return Array.isArray(points) && points.length >= 3 && polygonArea(points) >= INPAINT_MIN_LASSO_AREA;
}

/** Integer bounds of the lasso grown by `grow`, clipped to the image; null when nothing is inside. */
export function lassoBounds(points, grow, width, height) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  const b = {
    x0: Math.max(0, Math.floor(x0 - grow)),
    y0: Math.max(0, Math.floor(y0 - grow)),
    x1: Math.min(width, Math.ceil(x1 + grow)),
    y1: Math.min(height, Math.ceil(y1 + grow)),
  };
  return b.x1 > b.x0 && b.y1 > b.y0 ? b : null;
}

function slide(a0, a1, target, limit) {
  const start = Math.max(0, a0 - Math.floor((target - (a1 - a0)) / 2));
  const end = Math.min(limit, start + target);
  return [Math.max(0, end - target), end];
}

/**
 * The region of the image handed to the model: square, at least 512 px, the
 * hole plus margin, inside the image. On an image smaller than the square in
 * one direction, `w` or `h` is the whole image and the worker mirrors the rest.
 */
export function cropRegion(bounds, width, height) {
  const side = Math.max(INPAINT_INPUT, bounds.x1 - bounds.x0 + 2 * INPAINT_MARGIN, bounds.y1 - bounds.y0 + 2 * INPAINT_MARGIN);
  const [x0, x1] = slide(bounds.x0, bounds.x1, side, width);
  const [y0, y1] = slide(bounds.y0, bounds.y1, side, height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, side: Math.max(x1 - x0, y1 - y0) };
}

/** Drop lasso points closer than `minDist` to the last kept one (pointer noise). */
export function appendLassoPoint(points, point, minDist) {
  const last = points[points.length - 1];
  if (last && Math.hypot(point[0] - last[0], point[1] - last[1]) < minDist) return false;
  points.push(point);
  return true;
}
