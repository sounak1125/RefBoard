/**
 * Compare geometry: the pure maths behind the Compare view (two images over
 * each other as a wipe, an onion skin or a difference).
 *
 * Everything is in A's pixels. A's cropped source defines the frame, from
 * (0, 0) to (A width, A height). B is fitted inside that frame (contain, never
 * stretched), centred, then moved by the nudge. The view maps frame pixels to
 * stage CSS pixels: screen = frame * s + t.
 *
 * Loaded by index.html as a plain script (window.CompareGeometry) and by the
 * unit test as CommonJS.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompareGeometry = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // Zoom limits, in device pixels per A pixel.
  const ZOOM_MAX_DEVICE = 32;
  // How far out the view may go, as a fraction of the fitted scale.
  const ZOOM_MIN_OF_FIT = 0.25;
  // A fit that would leave less than this many A pixels uncovered on an axis is
  // a rounding difference, not a different shape: B fills the frame exactly.
  const SAME_SHAPE_SLACK_PX = 1;

  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

  function finite(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * A and B from two board items, given their bounding-box centres: A is the
   * one further left; on a tie, the one higher up; on a full tie, the first.
   */
  function orderAB(first, second) {
    const ax = finite(first?.cx), ay = finite(first?.cy);
    const bx = finite(second?.cx), by = finite(second?.cy);
    if (bx < ax) return [second, first];
    if (bx === ax && by < ay) return [second, first];
    return [first, second];
  }

  /**
   * Where B sits inside A's frame before any nudge: scaled to fit, centred.
   * `sameShape` is true when the aspect ratios match to within a pixel, and
   * then B covers the frame exactly.
   */
  function fitB(frame, bSize) {
    const fw = Math.max(0, finite(frame?.w)), fh = Math.max(0, finite(frame?.h));
    const bw = Math.max(0, finite(bSize?.w)), bh = Math.max(0, finite(bSize?.h));
    if (!fw || !fh || !bw || !bh) return { x: 0, y: 0, w: fw, h: fh, scale: 1, sameShape: true };
    const scale = Math.min(fw / bw, fh / bh);
    const w = bw * scale, h = bh * scale;
    if (fw - w < SAME_SHAPE_SLACK_PX && fh - h < SAME_SHAPE_SLACK_PX) {
      return { x: 0, y: 0, w: fw, h: fh, scale, sameShape: true };
    }
    return { x: (fw - w) / 2, y: (fh - h) / 2, w, h, scale, sameShape: false };
  }

  /** B's rect in frame pixels, with the nudge applied. */
  function placeB(frame, bSize, nudge) {
    const fit = fitB(frame, bSize);
    return {
      x: fit.x + finite(nudge?.x), y: fit.y + finite(nudge?.y),
      w: fit.w, h: fit.h, scale: fit.scale, sameShape: fit.sameShape,
    };
  }

  function intersect(a, b) {
    const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
    const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
    if (!(x1 > x0 && y1 > y0)) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /** The frame's area that B does not cover, as up to four rects (top, bottom, left, right). */
  function uncoveredRects(frame, bRect) {
    const f = { x: 0, y: 0, w: finite(frame?.w), h: finite(frame?.h) };
    const o = intersect(f, bRect);
    if (!o) return f.w > 0 && f.h > 0 ? [f] : [];
    const out = [];
    if (o.y > f.y) out.push({ x: f.x, y: f.y, w: f.w, h: o.y - f.y });
    if (o.y + o.h < f.y + f.h) out.push({ x: f.x, y: o.y + o.h, w: f.w, h: f.y + f.h - (o.y + o.h) });
    if (o.x > f.x) out.push({ x: f.x, y: o.y, w: o.x - f.x, h: o.h });
    if (o.x + o.w < f.x + f.w) out.push({ x: o.x + o.w, y: o.y, w: f.x + f.w - (o.x + o.w), h: o.h });
    return out;
  }

  /** The frame cut at the wipe line: A's side on the left, B's on the right. */
  function wipeSplit(frame, wipe) {
    const fw = finite(frame?.w), fh = finite(frame?.h);
    const x = clamp(finite(wipe, 0.5), 0, 1) * fw;
    return {
      x,
      left: { x: 0, y: 0, w: x, h: fh },
      right: { x, y: 0, w: fw - x, h: fh },
    };
  }

  /** The wipe position (0..1 of A's width) under a stage x. */
  function wipeAt(view, frame, sx) {
    const fw = finite(frame?.w);
    if (!(fw > 0)) return 0.5;
    return clamp((finite(sx) - view.tx) / view.s / fw, 0, 1);
  }

  /** A nudge moved by a drag of (dx, dy) stage pixels, in whole A pixels. */
  function dragNudge(start, dx, dy, s) {
    const k = finite(s, 1) > 0 ? s : 1;
    return {
      x: Math.round(finite(start?.x) + finite(dx) / k),
      y: Math.round(finite(start?.y) + finite(dy) / k),
    };
  }

  function stepNudge(nudge, dx, dy) {
    return { x: finite(nudge?.x) + finite(dx), y: finite(nudge?.y) + finite(dy) };
  }

  /**
   * The nudge after A and B swap roles. With the same shape the fits are exact
   * inverses (scale k one way, 1/k the other), so the alignment carries over:
   * the old offset, in B pixels and the other way round. With different shapes
   * a contain fit is not symmetric (a 2:1 B fits a square A by width, the
   * square fits the 2:1 frame by height), so no nudge keeps the alignment and
   * it goes back to zero.
   */
  function swapNudge(frameA, sizeB, nudge) {
    const old = placeB(frameA, sizeB, nudge);
    if (!old.sameShape || !(old.scale > 0)) return { x: 0, y: 0 };
    const tidy = v => Math.round(v * 1e6) / 1e6 || 0;
    return { x: tidy(-old.x / old.scale), y: tidy(-old.y / old.scale) };
  }

  const isNudged = nudge => finite(nudge?.x) !== 0 || finite(nudge?.y) !== 0;

  /** The view that fits A's frame in the stage, with `pad` CSS pixels around it. */
  function fitView(frame, stage, pad = 24) {
    const fw = Math.max(1, finite(frame?.w, 1)), fh = Math.max(1, finite(frame?.h, 1));
    const sw = Math.max(1, finite(stage?.w, 1)), sh = Math.max(1, finite(stage?.h, 1));
    const p = Math.max(0, Math.min(finite(pad), sw / 4, sh / 4));
    const s = Math.max(1e-6, Math.min((sw - 2 * p) / fw, (sh - 2 * p) / fh));
    return { s, tx: (sw - fw * s) / 2, ty: (sh - fh * s) / 2 };
  }

  /** The view at one A pixel per device pixel, centred on the stage point (cx, cy). */
  function actualPixelsView(view, cx, cy, dpr = 1) {
    return zoomAbout(view, cx, cy, 1 / Math.max(1e-6, finite(dpr, 1)));
  }

  function zoomLimits(fitScale, dpr = 1) {
    const d = Math.max(1e-6, finite(dpr, 1));
    const fit = Math.max(1e-6, finite(fitScale, 1));
    const max = ZOOM_MAX_DEVICE / d;
    return { min: Math.min(fit * ZOOM_MIN_OF_FIT, max), max: Math.max(max, fit) };
  }

  /** Zoom to scale `ns` keeping the stage point (cx, cy) over the same frame pixel. */
  function zoomAbout(view, cx, cy, ns, limits) {
    let s = finite(ns, view.s);
    if (limits) s = clamp(s, limits.min, limits.max);
    if (!(s > 0)) return { ...view };
    const k = s / view.s;
    return { s, tx: cx - (cx - view.tx) * k, ty: cy - (cy - view.ty) * k };
  }

  function frameToStage(view, x, y) {
    return [x * view.s + view.tx, y * view.s + view.ty];
  }

  function stageToFrame(view, sx, sy) {
    return [(sx - view.tx) / view.s, (sy - view.ty) / view.s];
  }

  const size = (w, h) => `${Math.round(w)} × ${Math.round(h)}`;

  /** The line under the stage. */
  function infoText({ a, b, sameShape, mode }) {
    const parts = [];
    if (Math.round(a.w) === Math.round(b.w) && Math.round(a.h) === Math.round(b.h)) parts.push(`Both ${size(a.w, a.h)}`);
    else parts.push(`A ${size(a.w, a.h)}`, `B ${size(b.w, b.h)}`);
    if (!sameShape) parts.push('different shapes — B letterboxed');
    if (mode === 'difference') parts.push('black = identical');
    parts.push('drag B to nudge', 'Esc to close');
    return parts.join(' · ');
  }

  return {
    ZOOM_MAX_DEVICE, ZOOM_MIN_OF_FIT, SAME_SHAPE_SLACK_PX,
    orderAB, fitB, placeB, intersect, uncoveredRects, wipeSplit, wipeAt,
    dragNudge, stepNudge, swapNudge, isNudged, fitView, actualPixelsView, zoomLimits, zoomAbout,
    frameToStage, stageToFrame, infoText,
  };
}));
