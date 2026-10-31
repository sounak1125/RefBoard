/* Raster Draw stroke geometry, in source-image pixels.
 *
 * A stroke paints into the image's own bitmap. Two rules keep it honest:
 *
 * - It only ever paints the part of the image the item shows. A cropped item
 *   hides pixels that are still in the bitmap, and painting them would surface
 *   later as marks nobody drew when the crop is widened. The window is rounded
 *   outward to whole pixels, so an edge pixel that is partly on screen still
 *   takes paint.
 * - Each pointer move recomposes only the pixels its segment can change: the
 *   segment's bounds grown by half the line width plus the brush's shadow, kept
 *   to that window. Recomposing the whole bitmap per move would stall a large
 *   image.
 */

/** The item's visible crop window in bitmap pixels, as whole pixels. */
export function drawCropWindow(crop, width, height) {
  const x = Math.max(0, Math.floor(crop.l * width));
  const y = Math.max(0, Math.floor(crop.t * height));
  const r = Math.min(width, Math.ceil(crop.r * width));
  const b = Math.min(height, Math.ceil(crop.b * height));
  return { x, y, w: Math.max(0, r - x), h: Math.max(0, b - y) };
}

/**
 * The whole-pixel rectangle a segment from (x0, y0) to (x1, y1) can change,
 * grown by `pad` and kept to `win`. Null when the segment lies entirely
 * outside the window, so a stroke that wanders off the image costs nothing.
 */
export function segmentDirtyRect(x0, y0, x1, y1, pad, win) {
  const l = Math.max(win.x, Math.floor(Math.min(x0, x1) - pad));
  const t = Math.max(win.y, Math.floor(Math.min(y0, y1) - pad));
  const r = Math.min(win.x + win.w, Math.ceil(Math.max(x0, x1) + pad));
  const b = Math.min(win.y + win.h, Math.ceil(Math.max(y0, y1) + pad));
  if (!(r > l && b > t)) return null;
  return { x: l, y: t, w: r - l, h: b - t };
}

/** `rect` grown by `pad` on every side and kept to `win`. */
export function growRect(rect, pad, win) {
  const l = Math.max(win.x, rect.x - pad);
  const t = Math.max(win.y, rect.y - pad);
  const r = Math.min(win.x + win.w, rect.x + rect.w + pad);
  const b = Math.min(win.y + win.h, rect.y + rect.h + pad);
  return { x: l, y: t, w: Math.max(0, r - l), h: Math.max(0, b - t) };
}

/**
 * How far a canvas shadow of the given blur reaches past the shape that casts
 * it. Chromium blurs with a Gaussian of sigma = blur / 2; at 4 sigma what is
 * left is far below one 8-bit step.
 */
export function shadowReach(blur) {
  return blur > 0 ? Math.ceil(blur * 2) : 0;
}
