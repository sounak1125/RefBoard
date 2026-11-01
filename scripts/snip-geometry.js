/**
 * Snip geometry: maps a drag on one display's overlay, in that display's own
 * DIP coordinates, to a crop rectangle on its frozen capture, in real pixels.
 *
 * The scale is measured from the capture itself (its pixel size against the
 * display's DIP bounds), never assumed to be the display's scaleFactor:
 * desktopCapturer fits a thumbnail inside the size asked for, so a display can
 * come back at some other size, and the crop has to follow what is there.
 *
 * Shared by main.js (the crop), the overlay (the live size label) and the unit
 * test, so it loads as CommonJS and as a plain script (window.SnipGeometry).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnipGeometry = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // A press that moves less than this many DIP either way is a click, which
  // takes the whole display.
  const CLICK_SLOP = 4;

  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

  function finite(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function isClick(start, end, slop = CLICK_SLOP) {
    const dx = Math.abs(finite(end?.x) - finite(start?.x));
    const dy = Math.abs(finite(end?.y) - finite(start?.y));
    return dx < slop && dy < slop;
  }

  /** Display-local DIP rectangle between two points, kept inside the display. */
  function dragRect(start, end, width, height) {
    const w = Math.max(0, finite(width));
    const h = Math.max(0, finite(height));
    const x0 = clamp(Math.min(finite(start?.x), finite(end?.x)), 0, w);
    const y0 = clamp(Math.min(finite(start?.y), finite(end?.y)), 0, h);
    const x1 = clamp(Math.max(finite(start?.x), finite(end?.x)), 0, w);
    const y1 = clamp(Math.max(finite(start?.y), finite(end?.y)), 0, h);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /** Capture pixels per DIP, per axis. */
  function captureScale(bounds, imageSize) {
    const bw = Math.max(1, finite(bounds?.width, 1));
    const bh = Math.max(1, finite(bounds?.height, 1));
    return {
      x: Math.max(0, finite(imageSize?.width)) / bw,
      y: Math.max(0, finite(imageSize?.height)) / bh,
    };
  }

  /* Each edge is rounded on its own, so two snips that share an edge in DIP
     share it in pixels too, and 600 DIP at 150% is exactly 900 px. */
  function edgeSpan(lo, hi, scale, limit) {
    let a = clamp(Math.round(lo * scale), 0, limit);
    let b = clamp(Math.round(hi * scale), 0, limit);
    if (b - a < 1) {
      // A sliver thinner than a pixel still gives one pixel, inside the image.
      b = Math.min(limit, a + 1);
      a = Math.max(0, b - 1);
    }
    return [a, b - a];
  }

  /**
   * The crop for a press at `start` and release at `end` (display-local DIP).
   * A click gives the whole capture. Returns null for an empty capture.
   */
  function cropForDrag({ start, end, bounds, imageSize, slop = CLICK_SLOP }) {
    const iw = Math.max(0, Math.floor(finite(imageSize?.width)));
    const ih = Math.max(0, Math.floor(finite(imageSize?.height)));
    if (!iw || !ih) return null;
    if (isClick(start, end, slop)) return { x: 0, y: 0, width: iw, height: ih, full: true };
    const rect = dragRect(start, end, bounds?.width, bounds?.height);
    const scale = captureScale(bounds, { width: iw, height: ih });
    const [x, width] = edgeSpan(rect.x, rect.x + rect.width, scale.x, iw);
    const [y, height] = edgeSpan(rect.y, rect.y + rect.height, scale.y, ih);
    return { x, y, width, height, full: false };
  }

  function sizeLabel(crop) {
    return crop ? `${crop.width} × ${crop.height}` : '';
  }

  return { CLICK_SLOP, isClick, dragRect, captureScale, cropForDrag, sizeLabel };
}));
