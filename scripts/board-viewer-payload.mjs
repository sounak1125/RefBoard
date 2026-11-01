/**
 * The Viewer / PDF board export: the pure parts the renderer runs.
 *
 *   buildViewerPayload  board items -> the JSON the viewer runtime reads
 *   cmdsToSvgPath       annotation-geometry path commands -> SVG path data
 *   safeLinkHref        the link schemes a viewer may open (http, https, mailto)
 *   fitLongEdge         long-edge resize maths (never upscales)
 *   estimateExportBytes the dialog's "≈ size" figure
 *
 * No DOM and no canvas. Anything that needs a canvas (note gutters, which are
 * measured text) or the app's state is handed in through `helpers`, so this
 * runs in Node for scripts/test-board-viewer.mjs exactly as it runs in the app.
 *
 * The payload is data only. Every string a user typed travels as a JSON
 * string and the runtime puts it into the page with textContent; main.js
 * escapes `<` when it writes the JSON into the HTML (board-export-main.js).
 */

export const VIEWER_SIZES = ['original', '2048', '1024'];
export const VIEWER_BOARD_PAD = 48;          // same margin as the board PNG export
export const VIEWER_JPEG_QUALITY = 0.9;
export const VIEWER_ALPHA_QUALITY = 0.9;      // WebP, keeps alpha
// A crop at Original is re-saved at full size: a lossless source stays
// lossless (PNG), a lossy one is re-saved close to its own quality.
export const VIEWER_ORIGINAL_QUALITY = 0.95;
export const VIEWER_LOSSY_MIMES = new Set(['image/jpeg', 'image/webp', 'image/avif']);

/** Long edge in px for an Image size choice; 0 means Original. */
export function viewerLongEdge(size) {
  const n = Number(size);
  return n === 2048 || n === 1024 ? n : 0;
}

/**
 * Scale (w, h) so the long edge is at most `maxEdge`. Never upscales; a
 * maxEdge of 0 (Original) returns the input. Both sides stay >= 1 px.
 */
export function fitLongEdge(w, h, maxEdge) {
  const W = Math.max(1, Math.round(Number(w) || 1));
  const H = Math.max(1, Math.round(Number(h) || 1));
  const max = Math.max(0, Math.floor(Number(maxEdge) || 0));
  const long = Math.max(W, H);
  if (!max || long <= max) return { w: W, h: H, scaled: false };
  const k = max / long;
  return {
    w: W >= H ? max : Math.max(1, Math.round(W * k)),
    h: H > W ? max : Math.max(1, Math.round(H * k)),
    scaled: true,
  };
}

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** The href a viewer may use for `url`, or null when it is not http(s)/mailto. */
export function safeLinkHref(url) {
  const raw = String(url ?? '').trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (!LINK_SCHEMES.has(parsed.protocol)) return null;
  if (parsed.protocol !== 'mailto:' && !parsed.hostname) return null;
  return parsed.href;
}

const r2 = v => Math.round(v * 100) / 100;
const fmt = v => {
  const n = r2(v);
  return Object.is(n, -0) ? '0' : String(n);
};

/**
 * Canvas path commands (see annotation-geometry.mjs) as SVG path data.
 * Canvas arc() draws a line to the arc's start first, then the arc; SVG has
 * no centre-form arc, so each arc becomes an L plus endpoint arcs of at most
 * half a turn (a full circle is two).
 */
export function cmdsToSvgPath(cmds) {
  const out = [];
  let open = false;
  for (const c of cmds || []) {
    switch (c[0]) {
      case 'M': out.push(`M${fmt(c[1])} ${fmt(c[2])}`); open = true; break;
      case 'L': out.push(`L${fmt(c[1])} ${fmt(c[2])}`); break;
      case 'Q': out.push(`Q${fmt(c[1])} ${fmt(c[2])} ${fmt(c[3])} ${fmt(c[4])}`); break;
      case 'A': {
        const [, cx, cy, r, a0, a1, ccw] = c;
        const TAU = Math.PI * 2;
        let sweep;
        if (!ccw && a1 - a0 >= TAU) sweep = TAU;
        else if (ccw && a0 - a1 >= TAU) sweep = TAU;
        else {
          sweep = ccw ? a0 - a1 : a1 - a0;
          sweep = ((sweep % TAU) + TAU) % TAU;
        }
        const dir = ccw ? -1 : 1;
        const sx = cx + r * Math.cos(a0), sy = cy + r * Math.sin(a0);
        out.push(`${open ? 'L' : 'M'}${fmt(sx)} ${fmt(sy)}`);
        open = true;
        const parts = sweep > Math.PI - 1e-9 ? 2 : 1;
        for (let i = 1; i <= parts; i++) {
          const a = a0 + dir * sweep * (i / parts);
          out.push(`A${fmt(r)} ${fmt(r)} 0 0 ${ccw ? 0 : 1} ${fmt(cx + r * Math.cos(a))} ${fmt(cy + r * Math.sin(a))}`);
        }
        break;
      }
      case 'Z': out.push('Z'); break;
      default: break;
    }
  }
  return out.join('');
}

/** One annotation as SVG paths in board space (arrow) or its base box (ink). */
function arrowSvg(a, h) {
  const color = a.color || '#000000';
  const geo = h.arrowGeometry(a);
  const paths = [];
  const shaft = geo.shaft ? cmdsToSvgPath(geo.shaft) : '';
  const heads = geo.heads.map(cmdsToSvgPath);
  const line = geo.line ? cmdsToSvgPath(h.smoothPolyline(geo.line)) : '';
  const dash = [r2(geo.width * 1.6), r2(geo.width * 2.1)];
  if (a.outline !== false) {
    const halo = h.annotationHaloColor(color);
    const hw = r2(geo.width * 1.1);
    if (line) paths.push({ d: line, stroke: halo, width: r2(geo.width + hw), dash });
    if (shaft) paths.push({ d: shaft, stroke: halo, width: hw });
    for (const d of heads) paths.push({ d, stroke: halo, width: hw });
  }
  if (line) paths.push({ d: line, stroke: color, width: r2(geo.width), dash });
  if (shaft) paths.push({ d: shaft, fill: color });
  for (const d of heads) paths.push({ d, fill: color });
  const b = h.arrowBounds(a, a.outline !== false ? (a.strokeWidth || 2) * 1.1 : 0);
  return { t: 'arrow', x: r2(b.x), y: r2(b.y), w: r2(b.w), h: r2(b.h), paths };
}

function inkSvg(it, h) {
  const highlighter = it.inkStyle === 'highlighter';
  const size = Number(it.size) || 4;
  const color = it.color || '#000000';
  const ds = (it.strokes || []).map(s => cmdsToSvgPath(highlighter ? h.smoothPolyline(s, 3) : h.inkStrokeOutline(s, size)));
  const paths = [];
  if (highlighter) {
    const width = r2(h.highlighterWidth(size));
    for (const d of ds) paths.push({ d, stroke: color, width });
  } else {
    if (it.outline !== false) {
      const halo = h.annotationHaloColor(color);
      for (const d of ds) paths.push({ d, stroke: halo, width: r2(size * 1.1), join: 'round' });
    }
    for (const d of ds) paths.push({ d, fill: color });
  }
  return {
    t: 'ink', x: r2(it.x), y: r2(it.y), w: r2(it.w), h: r2(it.h), rot: Number(it.rot) || 0,
    bw: r2(it.bw || it.w), bh: r2(it.bh || it.h), highlighter, paths,
  };
}

function noteLines(text, h) {
  const lines = String(text ?? '').split('\n');
  return lines.map(line => {
    const p = h.parseNoteLine(line);
    const segs = [];
    for (const seg of h.parseNoteLinkSegments(p.body)) {
      if (!seg.text) continue;
      if (seg.type === 'link') {
        const href = safeLinkHref(seg.url);
        segs.push(href ? { text: seg.text, href } : { text: seg.text });
      } else segs.push({ text: seg.text });
    }
    const out = { k: p.type, segs };
    if (p.type === 'check') out.checked = !!p.checked;
    if (p.type === 'number') out.n = p.n;
    return out;
  });
}

function bboxOfRects(rects) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    if (!r) continue;
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  if (!Number.isFinite(x1)) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

const isImage = it => !!it && (it.kind || 'image') === 'image';
const isNote = it => it?.kind === 'note';
const isGroup = it => it?.kind === 'group';
const isAnnot = it => it?.kind === 'arrow' || it?.kind === 'ink';

/**
 * The viewer payload.
 *
 *   items       board items in board order
 *   options     { notes: bool, labels: bool, allowSave: bool }
 *   board       { name, background, gray, tagColors }
 *   helpers     {
 *     imageRef(it)   -> { img, crop:[l,t,r,b] } | null   (which embedded image)
 *     images         -> [{ mime, w, h, name }]           (index = embedded image)
 *     noteMetrics(it)-> { eff, lineH, padX, padY, gutter }  board units
 *     groupBox(it)   -> board bbox of the group's children, or null
 *     groupKids(it)  -> ids of the group's children
 *     boundsOf(it)   -> rotated bbox of an item (images, notes, ink)
 *     annotation-geometry: arrowGeometry, arrowBounds, smoothPolyline,
 *       inkStrokeOutline, highlighterWidth, annotationHaloColor
 *     note-dom: parseNoteLine, parseNoteLinkSegments
 *   }
 */
export function buildViewerPayload({ items = [], options = {}, board = {}, helpers }) {
  const h = helpers;
  const withNotes = options.notes !== false;
  const withLabels = options.labels !== false;
  const tagIndex = new Map();
  const tags = [];
  const tagRefs = it => {
    if (!withLabels || !Array.isArray(it.tags) || !it.tags.length) return undefined;
    const refs = [];
    for (const raw of it.tags) {
      const name = String(raw ?? '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      let i = tagIndex.get(key);
      if (i === undefined) {
        i = tags.length;
        tagIndex.set(key, i);
        const color = board.tagColors?.[key] ?? board.tagColors?.[name];
        tags.push({ name, count: 0, ...(typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? { color } : {}) });
      }
      if (!refs.includes(i)) { refs.push(i); tags[i].count++; }
    }
    return refs.length ? refs : undefined;
  };

  const groups = [], imgs = [], notes = [], annots = [];
  const idToOut = new Map();
  const extent = [];
  for (const it of items) {
    if (isImage(it)) {
      const ref = h.imageRef(it);
      if (!ref) continue;
      const o = {
        t: 'img', id: String(it.id), x: r2(it.x), y: r2(it.y), w: r2(it.w), h: r2(it.h),
        rot: Number(it.rot) || 0, img: ref.img, crop: ref.crop.map(v => Math.round(v * 1e5) / 1e5),
      };
      if (it.flipX) o.fx = 1;
      if (it.flipY) o.fy = 1;
      if (it.gray) o.gray = 1;
      const tr = tagRefs(it);
      if (tr) o.tags = tr;
      imgs.push(o);
      idToOut.set(String(it.id), o);
      extent.push(h.boundsOf(it));
    } else if (isNote(it)) {
      if (!withNotes) continue;
      const m = h.noteMetrics(it);
      const o = {
        t: 'note', id: String(it.id), x: r2(it.x), y: r2(it.y), w: r2(it.w), h: r2(it.h),
        rot: Number(it.rot) || 0,
        bg: String(it.color || '#15161c'), op: it.opacity == null ? 1 : Math.max(0, Math.min(1, Number(it.opacity))),
        color: String(it.textColor || '#f0f2f6'),
        family: String(it.fontFamily || 'Segoe UI').trim().replace(/["\\]/g, '') || 'Segoe UI',
        size: m.eff, lineH: m.lineH, padX: m.padX, padY: m.padY, gutter: m.gutter,
        align: ['center', 'right'].includes(it.textAlign) ? it.textAlign : 'left',
        lines: noteLines(it.text, h),
      };
      if (it.bold) o.bold = 1;
      if (it.italic) o.italic = 1;
      if (it.underline) o.underline = 1;
      const tr = tagRefs(it);
      if (tr) o.tags = tr;
      notes.push(o);
      idToOut.set(String(it.id), o);
      extent.push(h.boundsOf(it));
    } else if (isAnnot(it)) {
      if (!withNotes) continue;
      const o = it.kind === 'arrow' ? arrowSvg(it, h) : inkSvg(it, h);
      if (!o.paths.length) continue;
      annots.push(o);
      extent.push(it.kind === 'arrow' ? o : h.boundsOf(it));
    }
  }
  for (const it of items) {
    if (!isGroup(it)) continue;
    const box = h.groupBox(it);
    if (!box) continue;
    const kids = (h.groupKids ? h.groupKids(it) : []).map(String);
    extent.push(box);
    groups.push({
      t: 'group', id: String(it.id), x: r2(box.x), y: r2(box.y), w: r2(box.w), h: r2(box.h),
      color: /^#[0-9a-f]{6}$/i.test(it.color || '') ? it.color : '#5aa2ff',
      name: String(it.name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 48),
      locked: it.locked ? 1 : 0,
      kids: kids.filter(id => idToOut.has(id)),
    });
  }

  const bb = bboxOfRects(extent) || { x: 0, y: 0, w: 1, h: 1 };
  const pad = VIEWER_BOARD_PAD;
  return {
    v: 1,
    name: String(board.name || 'Untitled board').slice(0, 200),
    bg: /^#[0-9a-f]{3,8}$/i.test(board.background || '') ? board.background : '#141a24',
    gray: board.gray ? 1 : 0,
    bounds: { x: r2(bb.x - pad), y: r2(bb.y - pad), w: r2(bb.w + pad * 2), h: r2(bb.h + pad * 2) },
    images: (h.images || []).map(im => ({
      mime: String(im.mime), w: im.w | 0, h: im.h | 0, name: String(im.name || 'image').slice(0, 120),
    })),
    items: [...groups, ...imgs, ...notes, ...annots],
    tags: withLabels ? tags.filter(t => t.count > 0) : [],
    allowSave: options.allowSave ? 1 : 0,
  };
}

/* ---------------- size estimate ----------------
   Bytes per output pixel for re-encoded images (JPEG 0.9 when opaque, WebP
   0.9 with alpha). Measured on a generated 40-image board (noise-textured
   photos, flat screenshots, cut-outs): photos landed at 0.15-0.18 B/px; real
   photos run denser, so the figure sits a little above that. Passthrough
   images (uncropped at Original, or a whole image already within the long
   edge) count their real byte size; a crop at Original counts its share of
   the source's bytes. */
export const EST_JPEG_BPP = 0.22;
export const EST_ALPHA_BPP = 0.3;
export const EST_PDF_FLATE_BPP = 1.6;     // ceiling for non-JPEG pixels as the PDF stores them
export const EST_PDF_FLATE_PER_BYTE = 1.2; // ...which in practice track the encoded file size
export const VIEWER_RUNTIME_BYTES = 34 * 1024;

const base64Size = n => Math.ceil(n / 3) * 4;

/**
 * plan: [{ bytes, mime, outW, outH, passthrough, srcPx, rectPx }] one per
 *   embedded image. bytes is the source file size (exact for passthrough),
 *   srcPx the source's pixel count, rectPx the pixels the output covers (a crop).
 * kind: 'viewer' | 'pdf'. payloadBytes: the JSON length.
 *
 * A re-encoded image is the smaller of two guesses: a flat bytes-per-pixel
 * figure (right for photos and for lossless sources), and the source's own
 * density scaled to the output (right for smooth images that compress far
 * better than a photo). Downscaled pixels carry more detail each, hence ^0.8.
 */
export function estimateExportBytes({ plan = [], kind = 'viewer', payloadBytes = 0, runtimeBytes = VIEWER_RUNTIME_BYTES } = {}) {
  let total = 0;
  for (const p of plan) {
    const px = Math.max(1, p.outW) * Math.max(1, p.outH);
    const alpha = p.mime !== 'image/jpeg' && p.alphaLikely !== false;
    let bytes;
    if (p.passthrough) bytes = Number(p.bytes) || 0;
    else if (p.original && p.bytes > 0 && p.srcPx > 0) {
      // The same pixels at about the source's own quality.
      bytes = p.bytes * Math.min(1, (Number(p.rectPx) || p.srcPx) / p.srcPx);
    } else {
      bytes = px * (alpha ? EST_ALPHA_BPP : EST_JPEG_BPP);
      const srcPx = Number(p.srcPx) || 0, rectPx = Number(p.rectPx) || srcPx;
      if (p.bytes > 0 && srcPx > 0 && rectPx > 0) {
        const fromSource = p.bytes * (rectPx / srcPx) * Math.pow(Math.min(1, px / rectPx), 0.8);
        bytes = Math.min(bytes, fromSource);
      }
    }
    if (kind === 'pdf') {
      // Chromium's PDF writer keeps JPEG streams as they are and stores every
      // other image as deflated pixels.
      const jpegOut = p.passthrough ? p.mime === 'image/jpeg' : !alpha;
      total += jpegOut ? bytes : Math.min(px * EST_PDF_FLATE_BPP, bytes * EST_PDF_FLATE_PER_BYTE);
    } else {
      total += base64Size(bytes) + 96;
    }
  }
  if (kind === 'pdf') return Math.round(total + 8 * 1024 + payloadBytes * 0.5);
  return Math.round(total + runtimeBytes + payloadBytes);
}

export function formatBytes(n) {
  const v = Math.max(0, Number(n) || 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${Math.round(v / 1024)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(v < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(v / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export const ESTIMATE_WARN_BYTES = 100 * 1024 * 1024;
