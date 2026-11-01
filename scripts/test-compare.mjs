/**
 * Compare, the pure parts (scripts/compare-geometry.js): which image is A,
 * how B fits inside A's frame, the letterbox, the wipe, the nudge, and the
 * view's fit and zoom.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('./compare-geometry.js');

const near = (actual, expected, msg, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${msg}: expected ${expected}, got ${actual}`);

/* ---------- A and B ---------- */
{
  const left = { id: 'L', cx: 100, cy: 500 };
  const right = { id: 'R', cx: 300, cy: 0 };
  assert.deepEqual(G.orderAB(left, right).map(x => x.id), ['L', 'R'], 'A is the one further left');
  assert.deepEqual(G.orderAB(right, left).map(x => x.id), ['L', 'R'], 'whatever order they were selected in');
  const top = { id: 'T', cx: 100, cy: 0 };
  const bottom = { id: 'B', cx: 100, cy: 80 };
  assert.deepEqual(G.orderAB(bottom, top).map(x => x.id), ['T', 'B'], 'on a tie in x, the one higher up is A');
  assert.deepEqual(G.orderAB(top, bottom).map(x => x.id), ['T', 'B']);
  const same1 = { id: '1', cx: 5, cy: 5 }, same2 = { id: '2', cx: 5, cy: 5 };
  assert.deepEqual(G.orderAB(same1, same2).map(x => x.id), ['1', '2'], 'a full tie keeps the given order');
}

/* ---------- fitting B into A's frame ---------- */
{
  // Same shape, different resolution: B covers the frame exactly.
  const f = G.fitB({ w: 1200, h: 800 }, { w: 600, h: 400 });
  assert.deepEqual([f.x, f.y, f.w, f.h, f.sameShape], [0, 0, 1200, 800, true]);
  near(f.scale, 2, 'B is scaled up 2x');

  // The brief's example: 1180x786 in 1200x800 is a rounding difference.
  const r = G.fitB({ w: 1200, h: 800 }, { w: 1180, h: 786 });
  assert.equal(r.sameShape, true, '1180x786 in 1200x800 leaves under a pixel, so it is the same shape');
  assert.deepEqual([r.x, r.y, r.w, r.h], [0, 0, 1200, 800]);

  // A wider B is letterboxed top and bottom, never stretched.
  const wide = G.fitB({ w: 1000, h: 1000 }, { w: 400, h: 200 });
  assert.equal(wide.sameShape, false);
  assert.deepEqual([wide.x, wide.y, wide.w, wide.h], [0, 250, 1000, 500]);
  near(wide.w / wide.h, 2, 'aspect kept');

  // A taller B is pillarboxed left and right.
  const tall = G.fitB({ w: 1200, h: 800 }, { w: 300, h: 400 });
  assert.equal(tall.sameShape, false);
  assert.deepEqual([tall.x, tall.y, tall.w, tall.h], [300, 0, 600, 800]);

  // 3 px short is a different shape.
  const off = G.fitB({ w: 1200, h: 800 }, { w: 600, h: 401 });
  assert.equal(off.sameShape, false, '1197 of 1200 is a different shape');

  // Degenerate sizes do not throw or divide by zero.
  assert.deepEqual(G.fitB({ w: 100, h: 50 }, { w: 0, h: 0 }), { x: 0, y: 0, w: 100, h: 50, scale: 1, sameShape: true });
}

/* ---------- nudge, overlap and letterbox ---------- */
{
  const frame = { w: 1000, h: 1000 };
  const b = G.placeB(frame, { w: 400, h: 200 }, { x: 10, y: -5 });
  assert.deepEqual([b.x, b.y, b.w, b.h], [10, 245, 1000, 500], 'the nudge moves B in A pixels');

  assert.deepEqual(G.intersect({ x: 0, y: 0, w: 1000, h: 1000 }, b), { x: 10, y: 245, w: 990, h: 500 });
  assert.equal(G.intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 }), null, 'touching edges do not overlap');

  const gaps = G.uncoveredRects(frame, b);
  const area = gaps.reduce((s, r) => s + r.w * r.h, 0);
  assert.equal(area, 1000 * 1000 - 990 * 500, 'the uncovered rects cover exactly the frame minus B');
  for (const r of gaps) assert.equal(G.intersect(r, b), null, 'no uncovered rect overlaps B');
  for (let i = 0; i < gaps.length; i++) {
    for (let j = i + 1; j < gaps.length; j++) assert.equal(G.intersect(gaps[i], gaps[j]), null, 'uncovered rects do not overlap each other');
  }
  assert.deepEqual(G.uncoveredRects(frame, G.placeB(frame, { w: 50, h: 50 }, { x: 0, y: 0 })), [], 'same shape leaves nothing uncovered');
  assert.deepEqual(G.uncoveredRects(frame, { x: 2000, y: 0, w: 10, h: 10 }), [{ x: 0, y: 0, w: 1000, h: 1000 }], 'B nudged right off the frame leaves all of it uncovered');

  assert.deepEqual(G.dragNudge({ x: 3, y: 4 }, 25, -10, 0.5), { x: 53, y: -16 }, 'a drag is screen pixels over the scale, rounded to whole A pixels');
  assert.deepEqual(G.dragNudge({ x: 0, y: 0 }, 0.4, 0.4, 1), { x: 0, y: 0 });
  assert.deepEqual(G.stepNudge({ x: 1, y: 1 }, -10, 0), { x: -9, y: 1 });
  // Swapping keeps the alignment: same size, the nudge just flips sign.
  assert.deepEqual(G.swapNudge({ w: 1200, h: 800 }, { w: 1200, h: 800 }, { x: 7, y: -3 }), { x: -7, y: 3 });
  // Half the resolution: 6 A pixels are 3 B pixels.
  assert.deepEqual(G.swapNudge({ w: 1200, h: 800 }, { w: 600, h: 400 }, { x: 6, y: -4 }), { x: -3, y: 2 });
  // Different shapes: no nudge keeps the alignment both ways, so it resets.
  assert.deepEqual(G.swapNudge({ w: 1000, h: 1000 }, { w: 400, h: 200 }, { x: 12, y: -30 }), { x: 0, y: 0 });
  assert.deepEqual(G.swapNudge({ w: 100, h: 100 }, { w: 100, h: 100 }, { x: 0, y: 0 }), { x: 0, y: 0 }, 'no nudge stays no nudge (not -0)');
  assert.equal(G.isNudged({ x: 0, y: 0 }), false);
  assert.equal(G.isNudged({ x: 0, y: -1 }), true);
}

/* ---------- wipe ---------- */
{
  const w = G.wipeSplit({ w: 1200, h: 800 }, 0.25);
  assert.equal(w.x, 300);
  assert.deepEqual(w.left, { x: 0, y: 0, w: 300, h: 800 });
  assert.deepEqual(w.right, { x: 300, y: 0, w: 900, h: 800 });
  assert.equal(G.wipeSplit({ w: 100, h: 10 }, 2).x, 100, 'the wipe stays inside the frame');
  assert.equal(G.wipeSplit({ w: 100, h: 10 }, -1).x, 0);

  const view = { s: 0.5, tx: 100, ty: 50 };
  near(G.wipeAt(view, { w: 1200, h: 800 }, 100 + 600 * 0.5), 0.5, 'the stage x over A pixel 600 of 1200 is a half');
  assert.equal(G.wipeAt(view, { w: 1200, h: 800 }, -500), 0);
  assert.equal(G.wipeAt(view, { w: 1200, h: 800 }, 5000), 1);
}

/* ---------- view: fit, zoom, 100% ---------- */
{
  const v = G.fitView({ w: 1200, h: 800 }, { w: 1000, h: 1000 }, 50);
  near(v.s, 0.75, 'fits the width');
  near(v.tx, 50, 'centred across');
  near(v.ty, (1000 - 600) / 2, 'centred down');

  const tallStage = G.fitView({ w: 6000, h: 4000 }, { w: 1600, h: 900 }, 24);
  near(tallStage.s, (900 - 48) / 4000, 'fits the height when the stage is wide');

  // Zoom about a point keeps that point over the same frame pixel.
  const z = G.zoomAbout(v, 400, 300, 3);
  const before = G.stageToFrame(v, 400, 300);
  const after = G.stageToFrame(z, 400, 300);
  near(after[0], before[0], 'zoom keeps x', 1e-9);
  near(after[1], before[1], 'zoom keeps y', 1e-9);
  const [sx, sy] = G.frameToStage(z, ...after);
  near(sx, 400, 'round trip x'); near(sy, 300, 'round trip y');

  const lim = G.zoomLimits(0.2, 1.25);
  near(lim.min, 0.05, 'out to a quarter of fit');
  near(lim.max, 32 / 1.25, 'in to 32 device pixels per A pixel');
  near(G.zoomAbout(v, 0, 0, 1000, lim).s, lim.max, 'clamped in');
  near(G.zoomAbout(v, 0, 0, 0.0001, lim).s, lim.min, 'clamped out');

  // 100% is one A pixel per device pixel.
  near(G.actualPixelsView(v, 500, 500, 1.25).s, 0.8, '100% at 125% display scaling');
  near(G.actualPixelsView(v, 500, 500, 1).s, 1, '100% at 100% display scaling');
}

/* ---------- the info line ---------- */
{
  assert.equal(
    G.infoText({ a: { w: 1200, h: 800 }, b: { w: 1180, h: 786 }, sameShape: true, mode: 'wipe' }),
    'A 1200 × 800 · B 1180 × 786 · drag B to nudge · Esc to close',
  );
  assert.equal(
    G.infoText({ a: { w: 1200, h: 800 }, b: { w: 1200, h: 800 }, sameShape: true, mode: 'onion' }),
    'Both 1200 × 800 · drag B to nudge · Esc to close',
  );
  assert.equal(
    G.infoText({ a: { w: 1000, h: 1000 }, b: { w: 400, h: 200 }, sameShape: false, mode: 'difference' }),
    'A 1000 × 1000 · B 400 × 200 · different shapes — B letterboxed · black = identical · drag B to nudge · Esc to close',
  );
}

console.log('compare geometry tests passed');
