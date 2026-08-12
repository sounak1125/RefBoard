/**
 * RefBoard flicker probe -- paste into DevTools on a REAL board.
 *
 * Records, per image item, the resolution of the surface each frame actually
 * drew. A "downgrade" is a frame that drew a lower-resolution source than the
 * same item was already showing; while zooming in or holding still, every
 * downgrade is a visible pop from sharp back to blurry.
 *
 *   1. Open the board that flickers, then Ctrl+Shift+I for DevTools.
 *   2. Paste this whole file into the Console and press Enter.
 *   3. Zoom around until you SEE it flicker.
 *   4. Run:  __flickerReport()
 *   5. Send the JSON back.
 *
 * __flickerStop() restores the original drawImage.
 */
(() => {
  if (window.__flickerStop) window.__flickerStop();

  const board = document.querySelector('#board');
  const ctx = board.getContext('2d');
  const original = ctx.drawImage;
  const BUCKET = 64;

  const isImageItem = it => it && it.kind !== 'note' && it.kind !== 'arrow'
    && it.kind !== 'group' && typeof it.imgId === 'string';

  // Item centres are constant in board space; only the view moves. Bucketing
  // absorbs the float error of inverting the transform at low zoom, where one
  // screen pixel is worth many board units.
  const buckets = new Map();
  let indexed = 0;
  for (const it of RefBoard.state.items) {
    if (!isImageItem(it)) continue;
    const cx = it.x + it.w / 2;
    const cy = it.y + it.h / 2;
    const key = Math.round(cx / BUCKET) + ':' + Math.round(cy / BUCKET);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ id: it.id, imgId: it.imgId, cx, cy, w: it.w, h: it.h });
    indexed++;
  }

  const locate = (bx, by) => {
    const gx = Math.round(bx / BUCKET);
    const gy = Math.round(by / BUCKET);
    let best = null;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const c of buckets.get((gx + dx) + ':' + (gy + dy)) || []) {
          const d = Math.hypot(c.cx - bx, c.cy - by);
          if (d < bestD && d <= Math.max(c.w, c.h) * 0.25 + BUCKET) { bestD = d; best = c; }
        }
      }
    }
    return best;
  };

  const state = {
    startedAt: performance.now(),
    lastWidth: new Map(),
    lastZoom: RefBoard.state.view.s,
    events: [],
    upgrades: 0,
    matched: 0,
    unmatched: 0,
    indexed,
  };

  ctx.drawImage = function(source, ...args) {
    if (args.length === 8) {
      const v = RefBoard.state.view;
      const dpr = devicePixelRatio || 1;
      const t = this.getTransform();
      const hit = locate((t.e / dpr - v.tx) / v.s, (t.f / dpr - v.ty) / v.s);
      if (!hit) {
        state.unmatched++;
      } else {
        state.matched++;
        const width = Number(source?.width) || 0;
        const previous = state.lastWidth.get(hit.id);
        if (previous && width < previous) {
          state.events.push({
            at: Math.round(performance.now() - state.startedAt),
            itemId: hit.id,
            from: previous,
            to: width,
            zoom: Number(v.s.toFixed(4)),
            // A downgrade while zooming out is legitimate: the image is smaller
            // on screen. While zooming in or still, it is the flicker.
            direction: v.s > state.lastZoom + 1e-9 ? 'in'
              : v.s < state.lastZoom - 1e-9 ? 'out' : 'still',
          });
          if (state.events.length > 5000) state.events.shift();
        } else if (previous && width > previous) {
          state.upgrades++;
        }
        state.lastWidth.set(hit.id, width);
      }
      state.lastZoom = v.s;
    }
    return original.call(this, source, ...args);
  };

  window.__flickerStop = () => {
    ctx.drawImage = original;
    delete window.__flickerStop;
    return 'flicker probe removed';
  };

  window.__flickerReport = async () => {
    const bad = state.events.filter(e => e.direction !== 'out');
    const perItem = new Map();
    for (const e of bad) perItem.set(e.itemId, (perItem.get(e.itemId) || 0) + 1);
    const pairs = new Map();
    for (const e of bad) {
      const k = e.from + '->' + e.to;
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
    const report = {
      seconds: Math.round((performance.now() - state.startedAt) / 100) / 10,
      dpr: devicePixelRatio,
      viewport: [board.clientWidth, board.clientHeight],
      itemsIndexed: state.indexed,
      totalItems: RefBoard.state.items.length,
      drawsMatched: state.matched,
      drawsUnmatched: state.unmatched,
      upgrades: state.upgrades,
      flickerEvents: bad.length,
      legitimateZoomOutDrops: state.events.length - bad.length,
      itemsAffected: perItem.size,
      worstItems: [...perItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
      transitions: [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10),
      sample: bad.slice(-25),
      memory: (await RefBoard.memoryStats()).images,
    };
    console.log(JSON.stringify(report, null, 2));
    return report;
  };

  return `flicker probe active on ${indexed} image items -- zoom until it flickers, then run __flickerReport()`;
})();
