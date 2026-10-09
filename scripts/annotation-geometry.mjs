/**
 * Geometry for board annotations: arrows, node-style links between items,
 * and ink (brush) strokes.
 *
 * Pure functions, no DOM. Outlines come back as path commands that the
 * renderer replays onto a canvas context or a Path2D (see replayPath), so the
 * shapes can be tested in Node and drawn identically on screen and in export.
 *
 * Command forms:
 *   ['M', x, y]  ['L', x, y]  ['Q', cx, cy, x, y]
 *   ['A', x, y, r, a0, a1, anticlockwise]  ['Z']
 *
 * Every size is proportional to the stroke width, so an annotation drawn at
 * 25% zoom looks the same as one drawn at 100% once the view matches.
 */

const TAU = Math.PI * 2;

export const ARROW_HEAD_LEN_MUL = 5;
export const INK_STYLES = ['pen', 'highlighter'];
export const ARROW_HEADS = ['end', 'both', 'none'];
export const LINK_SIDES = ['left', 'right', 'top', 'bottom'];

export function arrowHeadLength(width) {
  return Math.max(0, Number(width) || 0) * ARROW_HEAD_LEN_MUL;
}

/* ---------------- arrows and links ----------------
   A free arrow is a straight line from (x1, y1) to (x2, y2). A link is an
   arrow whose ends are plugged into board items, drawn the way Blender draws
   node links: it leaves one item's edge and enters the other's square to the
   edge, on a cubic curve whose handles are `curve` = [c1x, c1y, c2x, c2y].
   The end points and handles are derived from the items (see linkGeometry)
   and stored on the arrow, so bounds, hit tests and export read one shape. */

const SIDE_NORMALS = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };

function rotRadOf(r) { return ((Number(r.rot) || 0) * Math.PI) / 180; }

/** A point in board space expressed in a rect's own unrotated frame (centre origin). */
function toRectFrame(r, x, y) {
  const a = -rotRadOf(r), c = Math.cos(a), s = Math.sin(a);
  const dx = x - (r.x + r.w / 2), dy = y - (r.y + r.h / 2);
  return [dx * c - dy * s, dx * s + dy * c];
}

function fromRectFrame(r, lx, ly) {
  const a = rotRadOf(r), c = Math.cos(a), s = Math.sin(a);
  return [r.x + r.w / 2 + lx * c - ly * s, r.y + r.h / 2 + lx * s + ly * c];
}

/**
 * Which edge of `r` faces `other` (a rect, or a point as a zero-size rect).
 * The axis is the one the two are further apart on relative to their sizes,
 * so side-by-side images link left/right and stacked ones top/bottom, and
 * both ends of one link always agree.
 */
export function linkSide(r, other) {
  const [lx, ly] = toRectFrame(r, other.x + (other.w || 0) / 2, other.y + (other.h || 0) / 2);
  const spanX = Math.max(1e-9, (r.w + (other.w || 0)) / 2);
  const spanY = Math.max(1e-9, (r.h + (other.h || 0)) / 2);
  if (Math.abs(lx) / spanX >= Math.abs(ly) / spanY) return lx >= 0 ? 'right' : 'left';
  return ly >= 0 ? 'bottom' : 'top';
}

/**
 * Socket on `side` of `r`, `frac` (0..1) along that edge: its board point and
 * the edge's outward unit normal, both turned with the rect.
 */
export function linkSocket(r, side, frac = 0.5) {
  const hw = r.w / 2, hh = r.h / 2;
  const f = Math.min(0.9, Math.max(0.1, frac)) * 2 - 1;
  const local = {
    left: [-hw, f * hh], right: [hw, f * hh],
    top: [f * hw, -hh], bottom: [f * hw, hh],
  }[side] || [hw, 0];
  const [x, y] = fromRectFrame(r, local[0], local[1]);
  const [nx0, ny0] = SIDE_NORMALS[side] || SIDE_NORMALS.right;
  const a = rotRadOf(r), c = Math.cos(a), s = Math.sin(a);
  return { x, y, nx: nx0 * c - ny0 * s, ny: nx0 * s + ny0 * c };
}

/**
 * Blender's noodle: each handle runs out along its socket's normal, by half
 * the travel along that normal. A floor keeps a link between near neighbours
 * (or one that has to double back) from collapsing into a kink.
 * A free end (no normal) gets no handle.
 */
export function linkCurve(p0, n0, p3, n3, minHandle = 0) {
  const dx = p3.x - p0.x, dy = p3.y - p0.y;
  const dist = Math.hypot(dx, dy);
  const handle = n => Math.max(Math.abs(dx * n.nx + dy * n.ny) * 0.5, dist * 0.25, minHandle);
  const c1 = n0 ? [p0.x + n0.nx * handle(n0), p0.y + n0.ny * handle(n0)] : [p0.x, p0.y];
  const c2 = n3 ? [p3.x + n3.nx * handle(n3), p3.y + n3.ny * handle(n3)] : [p3.x, p3.y];
  return [c1[0], c1[1], c2[0], c2[1]];
}

/**
 * The full shape of every link on the board in one pass, so links sharing an
 * edge spread out along it in the order of whatever they reach, as node
 * sockets stack, instead of piling onto one point.
 *
 * links: [{ id, from: rect|null, to: rect|null, x1, y1, x2, y2, width }]
 * returns Map id -> { x1, y1, x2, y2, curve }
 */
export function linkGeometry(links) {
  const ends = [];
  const pointRect = (x, y) => ({ x, y, w: 0, h: 0 });
  for (const l of links) {
    const fromOther = l.to || pointRect(l.x2, l.y2);
    const toOther = l.from || pointRect(l.x1, l.y1);
    if (l.from) ends.push({ link: l, end: 'from', rect: l.from, side: linkSide(l.from, fromOther), toward: fromOther });
    if (l.to) ends.push({ link: l, end: 'to', rect: l.to, side: linkSide(l.to, toOther), toward: toOther });
  }
  // Group the ends by edge and order each group along it.
  const byEdge = new Map();
  for (const e of ends) {
    const key = `${e.rect.id ?? `${e.rect.x},${e.rect.y}`}|${e.side}`;
    if (!byEdge.has(key)) byEdge.set(key, []);
    byEdge.get(key).push(e);
  }
  for (const group of byEdge.values()) {
    const vertical = group[0].side === 'left' || group[0].side === 'right';
    for (const e of group) {
      const [lx, ly] = toRectFrame(e.rect, e.toward.x + (e.toward.w || 0) / 2, e.toward.y + (e.toward.h || 0) / 2);
      e.order = vertical ? ly : lx;
    }
    group.sort((a, b) => a.order - b.order || String(a.link.id).localeCompare(String(b.link.id)));
    group.forEach((e, i) => { e.frac = (i + 1) / (group.length + 1); });
  }
  const sockets = new Map();
  for (const e of ends) sockets.set(`${e.link.id}|${e.end}`, linkSocket(e.rect, e.side, e.frac));

  const out = new Map();
  for (const l of links) {
    const s0 = sockets.get(`${l.id}|from`) || { x: l.x1, y: l.y1, nx: 0, ny: 0, free: true };
    const s3 = sockets.get(`${l.id}|to`) || { x: l.x2, y: l.y2, nx: 0, ny: 0, free: true };
    const curve = linkCurve(s0, s0.free ? null : s0, s3, s3.free ? null : s3, (l.width || 2) * 8);
    out.set(l.id, { x1: s0.x, y1: s0.y, x2: s3.x, y2: s3.y, curve });
  }
  return out;
}

/** Flat [x, y, ...] samples along the arrow, tail to tip. */
export function sampleArrow(a, steps = 40) {
  const c = a.curve;
  if (!Array.isArray(c) || c.length !== 4) return [a.x1, a.y1, a.x2, a.y2];
  const n = Math.max(2, steps | 0);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
    out.push(
      k0 * a.x1 + k1 * c[0] + k2 * c[2] + k3 * a.x2,
      k0 * a.y1 + k1 * c[1] + k2 * c[3] + k3 * a.y2,
    );
  }
  return out;
}

function polylineLength(flat, stride = 2) {
  let len = 0;
  for (let i = stride; i < flat.length; i += stride) {
    len += Math.hypot(flat[i] - flat[i - stride], flat[i + 1] - flat[i + 1 - stride]);
  }
  return len;
}

/**
 * Cut `dist` of arc length off the end of a polyline. Returns the kept part;
 * the last kept point lies exactly `dist` from the original end along the line.
 */
function trimPolylineEnd(flat, dist) {
  if (!(dist > 0)) return flat.slice();
  let remaining = dist;
  for (let i = flat.length - 2; i >= 2; i -= 2) {
    const x = flat[i], y = flat[i + 1];
    const px = flat[i - 2], py = flat[i - 1];
    const seg = Math.hypot(x - px, y - py);
    if (seg >= remaining) {
      const k = seg > 0 ? (seg - remaining) / seg : 0;
      return [...flat.slice(0, i), px + (x - px) * k, py + (y - py) * k];
    }
    remaining -= seg;
  }
  return [flat[0], flat[1], flat[0], flat[1]];
}

function reversePairs(flat) {
  const out = [];
  for (let i = flat.length - 2; i >= 0; i -= 2) out.push(flat[i], flat[i + 1]);
  return out;
}

/**
 * Swept arrowhead: concave flanks and a notched back, so the head reads as a
 * drawn mark rather than a stock triangle.
 */
export function arrowHeadPath(tipX, tipY, ux, uy, headLen) {
  const vx = -uy, vy = ux;
  const half = headLen * 0.5;
  const bx = tipX - ux * headLen, by = tipY - uy * headLen;
  const kx = tipX - ux * headLen * 0.7, ky = tipY - uy * headLen * 0.7;
  const qx = tipX - ux * headLen * 0.5, qy = tipY - uy * headLen * 0.5;
  return [
    ['M', tipX, tipY],
    ['Q', qx + vx * half * 0.38, qy + vy * half * 0.38, bx + vx * half, by + vy * half],
    ['L', kx, ky],
    ['L', bx - vx * half, by - vy * half],
    ['Q', qx - vx * half * 0.38, qy - vy * half * 0.38, tipX, tipY],
    ['Z'],
  ];
}

function unitTowards(fromX, fromY, toX, toY, fallbackX, fallbackY) {
  const dx = toX - fromX, dy = toY - fromY;
  const len = Math.hypot(dx, dy);
  if (len > 1e-9) return [dx / len, dy / len];
  const fl = Math.hypot(fallbackX, fallbackY) || 1;
  return [fallbackX / fl, fallbackY / fl];
}

/**
 * Everything needed to draw one arrow.
 *   shaft: tube outline commands (solid) or null
 *   line:  flat polyline for a dashed shaft (dotted) or null
 *   heads: arrowhead outline commands
 *   width: shaft width at its widest
 */
export function arrowGeometry(a) {
  const width = Math.max(1e-3, Number(a.strokeWidth) || 2);
  const heads = ARROW_HEADS.includes(a.heads) ? a.heads : 'end';
  const dashed = a.arrowStyle === 'dotted';
  const samples = sampleArrow(a);
  const total = polylineLength(samples);
  const headLen = Math.min(arrowHeadLength(width), total * 0.45);
  const cut = headLen * 0.62;

  const headCmds = [];
  let body = samples;
  const n = samples.length;
  const chordX = a.x2 - a.x1, chordY = a.y2 - a.y1;
  if ((heads === 'end' || heads === 'both') && headLen > 0) {
    const trimmed = trimPolylineEnd(body, cut);
    const ex = trimmed[trimmed.length - 2], ey = trimmed[trimmed.length - 1];
    const [ux, uy] = unitTowards(ex, ey, samples[n - 2], samples[n - 1], chordX, chordY);
    headCmds.push(arrowHeadPath(samples[n - 2], samples[n - 1], ux, uy, headLen));
    body = trimmed;
  }
  if (heads === 'both' && headLen > 0) {
    const rev = trimPolylineEnd(reversePairs(body), cut);
    const sx = rev[rev.length - 2], sy = rev[rev.length - 1];
    const [ux, uy] = unitTowards(sx, sy, samples[0], samples[1], -chordX, -chordY);
    headCmds.push(arrowHeadPath(samples[0], samples[1], ux, uy, headLen));
    body = reversePairs(rev);
  }

  if (dashed) return { shaft: null, line: body, heads: headCmds, width };

  // A single head gets a shaft that swells from a fine tail into the head,
  // like a confident pen stroke. Double and headless arrows stay even.
  const half = width / 2;
  const pts = [];
  const radii = [];
  const bodyLen = polylineLength(body) || 1;
  let acc = 0;
  for (let i = 0; i < body.length; i += 2) {
    if (i > 0) acc += Math.hypot(body[i] - body[i - 2], body[i + 1] - body[i - 1]);
    pts.push(body[i], body[i + 1]);
    const s = acc / bodyLen;
    radii.push(heads === 'end' ? half * (0.42 + 0.58 * smoothstep(Math.min(1, s * 1.6))) : half);
  }
  return { shaft: tubeOutline(pts, radii), line: null, heads: headCmds, width };
}

/** Board-space box of an arrow including its head and an outline margin. */
export function arrowBounds(a, extraPad = 0) {
  const width = Math.max(1e-3, Number(a.strokeWidth) || 2);
  const pad = arrowHeadLength(width) * 0.6 + width + extraPad;
  const s = sampleArrow(a, 24);
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (let i = 0; i < s.length; i += 2) {
    x1 = Math.min(x1, s[i]); x2 = Math.max(x2, s[i]);
    y1 = Math.min(y1, s[i + 1]); y2 = Math.max(y2, s[i + 1]);
  }
  return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
}

export function arrowDistance(a, px, py) {
  return distanceToPolyline(sampleArrow(a, 32), px, py, 2);
}

/* ---------------- tubes and ink ---------------- */

/**
 * Closed outline of a variable-width tube through `pts` (flat x, y pairs)
 * with round caps. Sides are smoothed through segment midpoints.
 */
export function tubeOutline(pts, radii) {
  const n = pts.length / 2;
  if (!n) return [];
  if (n === 1 || polylineLength(pts) < 1e-6) {
    const r = Math.max(...radii.slice(0, n), 1e-3);
    return [['M', pts[0] + r, pts[1]], ['A', pts[0], pts[1], r, 0, TAU, false], ['Z']];
  }
  const left = [], right = [], angles = [];
  let lastDx = 1, lastDy = 0;
  for (let i = 0; i < n; i++) {
    const prev = Math.max(0, i - 1), next = Math.min(n - 1, i + 1);
    let dx = pts[next * 2] - pts[prev * 2];
    let dy = pts[next * 2 + 1] - pts[prev * 2 + 1];
    const len = Math.hypot(dx, dy);
    if (len > 1e-9) { dx /= len; dy /= len; lastDx = dx; lastDy = dy; }
    else { dx = lastDx; dy = lastDy; }
    const r = Math.max(1e-3, radii[i]);
    const x = pts[i * 2], y = pts[i * 2 + 1];
    left.push(x - dy * r, y + dx * r);
    right.push(x + dy * r, y - dx * r);
    angles.push(Math.atan2(dy, dx));
  }
  // Direction at the ends from the first/last real segment, not the averaged
  // one, so the caps sit square on the stroke.
  const cmds = [['M', left[0], left[1]]];
  smoothSide(cmds, left);
  const e = n - 1;
  cmds.push(['A', pts[e * 2], pts[e * 2 + 1], Math.max(1e-3, radii[e]), angles[e] + Math.PI / 2, angles[e] - Math.PI / 2, true]);
  smoothSide(cmds, reversePairs(right), true);
  cmds.push(['A', pts[0], pts[1], Math.max(1e-3, radii[0]), angles[0] - Math.PI / 2, angles[0] + Math.PI / 2, true]);
  cmds.push(['Z']);
  return cmds;
}

/** Continue a path through flat points with midpoint quadratic smoothing. */
function smoothSide(cmds, side, lineToStart = false) {
  const n = side.length / 2;
  if (lineToStart) cmds.push(['L', side[0], side[1]]);
  if (n < 3) {
    for (let i = 1; i < n; i++) cmds.push(['L', side[i * 2], side[i * 2 + 1]]);
    return;
  }
  for (let i = 1; i < n - 1; i++) {
    const x = side[i * 2], y = side[i * 2 + 1];
    const nx = side[i * 2 + 2], ny = side[i * 2 + 3];
    cmds.push(['Q', x, y, (x + nx) / 2, (y + ny) / 2]);
  }
  cmds.push(['L', side[(n - 1) * 2], side[(n - 1) * 2 + 1]]);
}

/** Smoothed open polyline (for highlighter strokes and dashed shafts). */
export function smoothPolyline(flat, stride = 2) {
  const n = Math.floor(flat.length / stride);
  if (!n) return [];
  const cmds = [['M', flat[0], flat[1]]];
  if (n === 1) { cmds.push(['L', flat[0] + 1e-3, flat[1]]); return cmds; }
  if (n === 2) { cmds.push(['L', flat[stride], flat[stride + 1]]); return cmds; }
  for (let i = 1; i < n - 1; i++) {
    const x = flat[i * stride], y = flat[i * stride + 1];
    const nx = flat[(i + 1) * stride], ny = flat[(i + 1) * stride + 1];
    cmds.push(['Q', x, y, (x + nx) / 2, (y + ny) / 2]);
  }
  cmds.push(['L', flat[(n - 1) * stride], flat[(n - 1) * stride + 1]]);
  return cmds;
}

/**
 * Pen ink: a pressure- and speed-shaped nib with tapered entry and exit.
 * `flat` is [x, y, pressure, ...] with pressure in 0..1.
 */
export function inkStrokeOutline(flat, size) {
  const n = Math.floor(flat.length / 3);
  if (!n) return [];
  const half = Math.max(1e-3, size / 2);
  const pts = [];
  const cum = [0];
  for (let i = 0; i < n; i++) {
    pts.push(flat[i * 3], flat[i * 3 + 1]);
    if (i > 0) cum.push(cum[i - 1] + Math.hypot(flat[i * 3] - flat[i * 3 - 3], flat[i * 3 + 1] - flat[i * 3 - 2]));
  }
  const total = cum[n - 1];
  const taper = Math.min(total * 0.32, size * 3.2);
  const radii = [];
  for (let i = 0; i < n; i++) {
    const p = clamp(Number(flat[i * 3 + 2]), 0, 1);
    let r = half * (0.38 + 0.82 * p);
    if (taper > 0) {
      r *= 0.5 + 0.5 * easeOutQuad(Math.min(1, cum[i] / taper));
      r *= 0.28 + 0.72 * easeOutQuad(Math.min(1, (total - cum[i]) / taper));
    }
    radii.push(r);
  }
  return tubeOutline(pts, radii);
}

/** Radius of the widest possible ink nib, for bounds and hit tests. */
export function inkMaxRadius(style, size) {
  return style === 'highlighter' ? highlighterWidth(size) / 2 : (size / 2) * 1.2;
}

export function highlighterWidth(size) {
  return Math.max(1e-3, size);
}

/** Bounds of a set of [x, y, p, ...] strokes, padded by the nib. */
export function inkPointsBounds(strokes, pad = 0) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i + 1 < s.length; i += 3) {
      x1 = Math.min(x1, s[i]); x2 = Math.max(x2, s[i]);
      y1 = Math.min(y1, s[i + 1]); y2 = Math.max(y2, s[i + 1]);
    }
  }
  if (!Number.isFinite(x1)) return null;
  return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
}

/**
 * Drop points that add nothing at the stroke's own scale: closer than
 * `minDist` to the last kept point. The first and last points always stay.
 */
export function thinStroke(flat, minDist) {
  const n = Math.floor(flat.length / 3);
  if (n <= 2) return flat.slice(0, n * 3);
  const out = [flat[0], flat[1], flat[2]];
  for (let i = 1; i < n - 1; i++) {
    const x = flat[i * 3], y = flat[i * 3 + 1];
    if (Math.hypot(x - out[out.length - 3], y - out[out.length - 2]) < minDist) continue;
    out.push(x, y, flat[i * 3 + 2]);
  }
  const e = (n - 1) * 3;
  out.push(flat[e], flat[e + 1], flat[e + 2]);
  return out;
}

export function distanceToPolyline(flat, px, py, stride = 2) {
  const n = Math.floor(flat.length / stride);
  if (!n) return Infinity;
  if (n === 1) return Math.hypot(px - flat[0], py - flat[1]);
  let best = Infinity;
  for (let i = 1; i < n; i++) {
    const ax = flat[(i - 1) * stride], ay = flat[(i - 1) * stride + 1];
    const bx = flat[i * stride], by = flat[i * stride + 1];
    best = Math.min(best, pointSegmentDistance(px, py, ax, ay, bx, by));
  }
  return best;
}

export function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? clamp(((px - ax) * vx + (py - ay) * vy) / len2, 0, 1) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

/**
 * Pressure for a mouse or trackpad, which report none: fast travel thins the
 * nib, slow travel swells it, eased so it never flickers between samples.
 */
export function simulatedPressure(prev, screenDist) {
  const target = clamp(1.04 - screenDist / 34, 0.32, 1);
  return prev + (target - prev) * 0.32;
}

/** Real pen pressure, softened so a light touch still leaves a readable line. */
export function penPressure(raw) {
  const p = clamp(Number(raw) || 0, 0, 1);
  return 0.18 + 0.82 * Math.pow(p, 0.75);
}

/* ---------------- colour ---------------- */

/** A contrasting outline colour so a mark reads on both light and dark images. */
export function annotationHaloColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  const v = m ? parseInt(m[1], 16) : 0;
  const lin = c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin((v >> 16) & 255) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255);
  return L > 0.4 ? 'rgba(10,11,15,0.6)' : 'rgba(255,255,255,0.94)';
}

/* ---------------- replay ---------------- */

/** Replay commands onto anything with the CanvasPath interface. */
export function replayPath(target, cmds) {
  for (const c of cmds) {
    switch (c[0]) {
      case 'M': target.moveTo(c[1], c[2]); break;
      case 'L': target.lineTo(c[1], c[2]); break;
      case 'Q': target.quadraticCurveTo(c[1], c[2], c[3], c[4]); break;
      case 'A': target.arc(c[1], c[2], c[3], c[4], c[5], c[6]); break;
      case 'Z': target.closePath(); break;
      default: break;
    }
  }
  return target;
}

/* ---------------- helpers ---------------- */

function clamp(v, a, b) { return Math.max(a, Math.min(b, Number.isFinite(v) ? v : a)); }
function smoothstep(t) { return t * t * (3 - 2 * t); }
function easeOutQuad(t) { return t * (2 - t); }
