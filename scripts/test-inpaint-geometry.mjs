/**
 * Content-aware fill geometry. The crop rule has to match the bake-off's
 * Python (scripts/inpaint-bakeoff/onnx-engines.py) or the app would be running
 * a different engine from the one that was chosen; the cases below are its
 * crops for real bake-off images, recomputed by hand.
 */
import assert from 'node:assert/strict';
import {
  INPAINT_INPUT, INPAINT_MARGIN, inpaintGrowPx, polygonArea, isUsableLasso, lassoBounds, cropRegion, appendLassoPoint,
} from './inpaint-geometry.mjs';

assert.equal(INPAINT_INPUT, 512);
assert.equal(INPAINT_MARGIN, 196);

// Growth: the diagonal reach of the bake-off's square 1.1% kernel (30 px at
// 2752 reaches 42.4 px on a diagonal), so a round growth misses nothing it caught.
assert.equal(inpaintGrowPx(2752, 1536), 43);
assert.ok(inpaintGrowPx(2752, 1536) >= Math.round(0.011 * 2752) * Math.SQRT2, 'at least the square kernel\'s diagonal reach');
assert.equal(inpaintGrowPx(1536, 2720), 42);
assert.equal(inpaintGrowPx(3168, 1344), 49);
assert.equal(inpaintGrowPx(100, 80), 2, 'tiny images still get a minimum growth');

assert.equal(polygonArea([[0, 0], [10, 0], [10, 10], [0, 10]]), 100);
assert.equal(polygonArea([[0, 0], [0, 10], [10, 10], [10, 0]]), 100, 'winding does not change the area');
assert.equal(isUsableLasso([[0, 0], [10, 0]]), false, 'two points are not a lasso');
assert.equal(isUsableLasso([[0, 0], [10, 0], [20, 0]]), false, 'a straight line encloses nothing');
assert.equal(isUsableLasso([[0, 0], [10, 0], [10, 10]]), true);

// Bounds grow by the margin and stay inside the image.
assert.deepEqual(lassoBounds([[100, 100], [200, 100], [150, 180]], 10, 1000, 800), { x0: 90, y0: 90, x1: 210, y1: 190 });
assert.deepEqual(lassoBounds([[-50, -20], [30, 5], [10, 40]], 5, 100, 100), { x0: 0, y0: 0, x1: 35, y1: 45 });
assert.equal(lassoBounds([[-50, -50], [-10, -50], [-20, -10]], 2, 100, 100), null, 'a lasso entirely off the image has nothing to fill');

// Small hole: the 512 floor wins, centred on the hole.
assert.deepEqual(cropRegion({ x0: 1000, y0: 500, x1: 1100, y1: 560 }, 2752, 1536), { x: 794, y: 274, w: 512, h: 512, side: 512 });

// The bake-off's moon case: its ellipse grown 30 px spans 1084..1668 x 284..868
// on a 2752x1536 image, and the bake-off's crop was 976 px square at (888, 88).
// (The crop rule is unchanged by the app's wider growth; this pins the rule.)
assert.deepEqual(cropRegion({ x0: 1084, y0: 284, x1: 1668, y1: 868 }, 2752, 1536), { x: 888, y: 88, w: 976, h: 976, side: 976 });

// Near an edge the square slides inward instead of shrinking.
{
  const r = cropRegion({ x0: 0, y0: 0, x1: 100, y1: 100 }, 2000, 1000);
  assert.deepEqual(r, { x: 0, y: 0, w: 512, h: 512, side: 512 });
  const s = cropRegion({ x0: 1950, y0: 950, x1: 2000, y1: 1000 }, 2000, 1000);
  assert.deepEqual(s, { x: 1488, y: 488, w: 512, h: 512, side: 512 });
}

// A hole taller than the image is wide: the square is clipped to the image width
// and the worker mirrors the rest; it never reaches outside the image.
{
  const r = cropRegion({ x0: 100, y0: 100, x1: 300, y1: 1500 }, 400, 1600);
  assert.equal(r.x, 0);
  assert.equal(r.w, 400);
  assert.equal(r.h, 1600);
  assert.equal(r.side, 1600);
}

// Pointer noise is dropped, deliberate movement kept.
{
  const pts = [];
  assert.equal(appendLassoPoint(pts, [0, 0], 2), true);
  assert.equal(appendLassoPoint(pts, [1, 1], 2), false);
  assert.equal(appendLassoPoint(pts, [3, 0], 2), true);
  assert.deepEqual(pts, [[0, 0], [3, 0]]);
}

console.log('inpaint geometry tests passed');
