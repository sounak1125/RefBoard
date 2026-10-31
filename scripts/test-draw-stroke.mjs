import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { drawCropWindow, growRect, segmentDirtyRect, shadowReach } from './draw-stroke.mjs';

/* The crop window is the shown part of the bitmap, rounded outward. */
assert.deepEqual(drawCropWindow({ l: 0, t: 0, r: 1, b: 1 }, 1920, 1080), { x: 0, y: 0, w: 1920, h: 1080 });
assert.deepEqual(drawCropWindow({ l: 0.25, t: 0.1, r: 0.75, b: 0.9 }, 1000, 500), { x: 250, y: 50, w: 500, h: 400 });
assert.deepEqual(drawCropWindow({ l: 0.1001, t: 0, r: 0.4999, b: 1 }, 1000, 10), { x: 100, y: 0, w: 400, h: 10 },
  'a partly shown edge pixel stays paintable');

const win = { x: 100, y: 50, w: 400, h: 300 };

/* A segment's dirty rectangle: its bounds grown by the pad, in whole pixels. */
assert.deepEqual(segmentDirtyRect(200, 100, 260, 100, 5, win), { x: 195, y: 95, w: 70, h: 10 });
assert.deepEqual(segmentDirtyRect(260.5, 140.2, 200.25, 100.7, 4, win), { x: 196, y: 96, w: 69, h: 49 },
  'endpoints in either order, rounded outward');

/* Kept to the window: a stroke never touches cropped-away pixels. */
assert.deepEqual(segmentDirtyRect(90, 60, 120, 60, 8, win), { x: 100, y: 52, w: 28, h: 16 });
assert.deepEqual(segmentDirtyRect(480, 340, 560, 400, 10, win), { x: 470, y: 330, w: 30, h: 20 });

/* Off the image entirely: nothing to repaint, however long the segment. */
assert.equal(segmentDirtyRect(0, 0, 60, 20, 10, win), null);
assert.equal(segmentDirtyRect(600, 0, 600, 1000, 10, win), null, 'past the right edge, top to bottom');
assert.equal(segmentDirtyRect(100 - 12, 200, 100 - 11, 200, 10, win), null, 'the pad alone does not reach in');
assert.notEqual(segmentDirtyRect(100 - 9, 200, 100 - 9, 200, 10, win), null, 'but a wide enough brush does');

/* Re-entry on the far side repaints only where the pointer comes back in:
   the exit and re-entry points are never joined across the image. */
const exit = segmentDirtyRect(495, 200, 520, 200, 6, win);
const reentry = segmentDirtyRect(80, 220, 110, 220, 6, win);
assert.ok(exit.x >= 489 && exit.x + exit.w <= 500, 'exit stays at the right edge');
assert.ok(reentry.x === 100 && reentry.x + reentry.w <= 116, 're-entry stays at the left edge');

/* The glow margin grows a rectangle, still inside the window. */
assert.deepEqual(growRect({ x: 200, y: 100, w: 20, h: 10 }, 6, win), { x: 194, y: 94, w: 32, h: 22 });
assert.deepEqual(growRect({ x: 102, y: 52, w: 20, h: 10 }, 6, win), { x: 100, y: 50, w: 28, h: 18 });
assert.equal(shadowReach(0), 0);
assert.equal(shadowReach(7.5), 15);

/* The renderer wiring the smoke relies on. */
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const segment = html.slice(html.indexOf('function drawStrokeSegment('), html.indexOf('function commitDrawSession('));
assert.ok(segment.includes('segmentDirtyRect('), 'brush segments recompose only their dirty rectangle');
assert.ok(segment.includes('composeDrawStroke(s, dirty)'), 'brush segments lay the stroke layer over the pre-stroke pixels');
assert.ok(!/globalAlpha\s*=\s*b(?:rush)?\.alpha/.test(segment), 'segments must not be stroked at the brush alpha one by one');
assert.ok(segment.includes('ctx.rect(win.x, win.y, win.w, win.h)'), 'the eraser is clipped to the crop window');
const move = html.slice(html.indexOf("} else if (mode.type === 'draw') {"), html.indexOf("} else if (mode.type === 'fillLasso') {"));
assert.ok(move.includes('boardPointToSource('), 'a stroke keeps mapping the pointer past the item edge');
assert.ok(!move.includes('boardPointToBitmap('), 'off-item points must not be dropped mid-stroke');
assert.ok(/imageResidency\.pin\(im\);[\s\S]*preStroke: im\.bitmap/.test(html), 'the pre-stroke bitmap is pinned for the stroke');
assert.ok(/imageResidency\.unpin\(session\.pinned\)/.test(html), 'releasing the session drops that pin');

console.log('draw stroke tests passed');
