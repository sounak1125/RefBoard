import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  annotationHaloColor,
  arrowBounds,
  arrowDistance,
  arrowGeometry,
  arrowHeadLength,
  distanceToPolyline,
  inkPointsBounds,
  inkStrokeOutline,
  linkCurve,
  linkGeometry,
  linkSide,
  linkSocket,
  penPressure,
  replayPath,
  sampleArrow,
  simulatedPressure,
  thinStroke,
  tubeOutline,
} from './annotation-geometry.mjs';

const near = (a, b, eps = 1e-6, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b}, got ${a}`);

/* Replay into a recorder that tracks extents, standing in for a canvas. */
function extents(cmds) {
  const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity, n: 0 };
  const add = (x, y) => {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), 'every path coordinate is finite');
    box.x1 = Math.min(box.x1, x); box.x2 = Math.max(box.x2, x);
    box.y1 = Math.min(box.y1, y); box.y2 = Math.max(box.y2, y);
    box.n++;
  };
  replayPath({
    moveTo: add, lineTo: add,
    quadraticCurveTo: (cx, cy, x, y) => { add(cx, cy); add(x, y); },
    arc: (x, y, r) => { add(x - r, y - r); add(x + r, y + r); },
    closePath() {},
  }, cmds);
  return box;
}

/* ---- arrows ---- */
const straight = { x1: 0, y1: 0, x2: 200, y2: 0, strokeWidth: 4 };
assert.deepEqual(sampleArrow(straight), [0, 0, 200, 0], 'a free arrow is a single straight segment');
near(arrowDistance(straight, 100, 3), 3, 1e-9);

/* ---- links ---- */
const A = { id: 'a', x: 0, y: 0, w: 100, h: 80 };
const B = { id: 'b', x: 300, y: 40, w: 100, h: 80 };
const C = { id: 'c', x: 10, y: 400, w: 100, h: 80 };
assert.equal(linkSide(A, B), 'right', 'side by side: leave from the facing edge');
assert.equal(linkSide(B, A), 'left', 'and enter the opposite one');
assert.equal(linkSide(A, C), 'bottom', 'stacked: top and bottom');
assert.equal(linkSide(C, A), 'top');
assert.equal(linkSide(A, { x: -50, y: 40, w: 0, h: 0 }), 'left', 'a free point counts as a zero-size box');
// Rotated 90 degrees, the item's own right edge faces down.
assert.equal(linkSide({ ...A, rot: 90 }, { x: 50, y: 500, w: 0, h: 0 }), 'right');

const sock = linkSocket(A, 'right', 0.5);
assert.deepEqual([sock.x, sock.y, sock.nx, sock.ny], [100, 40, 1, 0], 'a socket sits mid-edge, normal pointing out');
const turned = linkSocket({ ...A, rot: 90 }, 'right', 0.5);
near(turned.x, 50, 1e-9); near(turned.y, 90, 1e-9); near(turned.nx, 0, 1e-9); near(turned.ny, 1, 1e-9, 'sockets turn with the item');
near(linkSocket(A, 'left', 0).y, 8, 1e-9, 'sockets stay off the corners');

// Blender noodle: handles run straight out of each socket, so the curve
// leaves and enters square to the edges.
const geo = linkGeometry([{ id: 'l', from: A, to: B, x1: 0, y1: 0, x2: 0, y2: 0, width: 2 }]).get('l');
assert.deepEqual([geo.x1, geo.y1, geo.x2, geo.y2], [100, 40, 300, 80]);
near(geo.curve[1], 40, 1e-9, 'the first handle is level with the source socket');
near(geo.curve[3], 80, 1e-9, 'the second handle is level with the target socket');
assert.ok(geo.curve[0] > 100 && geo.curve[2] < 300, 'handles point out of each edge, toward each other');
const link = { ...geo, strokeWidth: 2 };
const ls = sampleArrow(link, 40);
for (let i = 2; i < ls.length; i += 2) assert.ok(ls[i] >= ls[i - 2] - 1e-9, 'a forward link never doubles back');
near((ls[3] - ls[1]) / (ls[2] - ls[0]), 0, 0.02, 'square out of the source');
near((ls.at(-1) - ls.at(-3)) / (ls.at(-2) - ls.at(-4)), 0, 0.02, 'square into the target');
assert.ok(arrowDistance(link, ls[40], ls[41]) < 0.5, 'hit testing follows the link');

// A link that has to go backwards still leaves and enters through its edges.
const back = linkGeometry([{ id: 'k', from: B, to: A, width: 2 }]).get('k');
assert.equal(back.x1, 300, 'B to A leaves B on its left');
assert.equal(back.x2, 100, 'and enters A on its right');

// Several links on one edge spread out along it, ordered by where they go.
const D = { id: 'd', x: 300, y: -120, w: 100, h: 80 };
const E = { id: 'e', x: 300, y: 200, w: 100, h: 80 };
const many = linkGeometry([
  { id: 'toE', from: A, to: E, width: 2 },
  { id: 'toD', from: A, to: D, width: 2 },
  { id: 'toB', from: A, to: B, width: 2 },
]);
assert.ok(['toE', 'toD', 'toB'].every(id => many.get(id).x1 === 100), 'all three leave A on its right');
assert.ok(many.get('toD').y1 < many.get('toB').y1 && many.get('toB').y1 < many.get('toE').y1, 'stacked in the order of their targets');
assert.equal(new Set(['toE', 'toD', 'toB'].map(id => many.get(id).y1)).size, 3, 'no two share a socket');

// Half-plugged: the free end is a plain point with no handle.
const half = linkGeometry([{ id: 'h', from: A, to: null, x1: 0, y1: 0, x2: 260, y2: 40, width: 2 }]).get('h');
assert.deepEqual([half.x1, half.y1, half.x2, half.y2], [100, 40, 260, 40]);
assert.deepEqual(half.curve.slice(2), [260, 40], 'the free end gets no handle');

const tight = linkCurve({ x: 0, y: 0 }, { nx: 1, ny: 0 }, { x: 1, y: 0 }, { nx: -1, ny: 0 }, 30);
assert.equal(tight[0], 30, 'neighbours still get a readable curve');

// Width-proportional: the same arrow at 4x scale is the same shape at 4x.
const g1 = arrowGeometry({ ...straight, heads: 'end' });
const g4 = arrowGeometry({ x1: 0, y1: 0, x2: 800, y2: 0, strokeWidth: 16, heads: 'end' });
const e1 = extents([...g1.shaft, ...g1.heads[0]]), e4 = extents([...g4.shaft, ...g4.heads[0]]);
near(e4.y2, e1.y2 * 4, 1e-6, 'arrow geometry scales with its width');
near(arrowHeadLength(4), arrowHeadLength(1) * 4, 1e-9);

// A single head: shaft tapers from a fine tail into the head.
const tail = extents(g1.shaft);
assert.ok(tail.x2 < 200, 'the shaft stops inside the head, not at the tip');
assert.equal(g1.heads.length, 1);
const head = extents(g1.heads[0]);
near(head.x2, 200, 1e-9, 'the head tip sits on the end point');
assert.ok(head.y2 - head.y1 > 4 * 2, 'the head is wider than the shaft');

assert.equal(arrowGeometry({ ...straight, heads: 'both' }).heads.length, 2);
assert.equal(arrowGeometry({ ...straight, heads: 'none' }).heads.length, 0);
const both = extents(arrowGeometry({ ...straight, heads: 'both' }).heads[1]);
near(both.x1, 0, 1e-9, 'the second head sits on the start point');

const dotted = arrowGeometry({ ...link, arrowStyle: 'dotted' });
assert.equal(dotted.shaft, null);
assert.ok(dotted.line.length >= 4, 'a dotted arrow strokes a polyline');

// A very short arrow keeps a head no longer than most of its length.
const stub = arrowGeometry({ x1: 0, y1: 0, x2: 10, y2: 0, strokeWidth: 8 });
assert.ok(extents(stub.heads[0]).x1 >= -0.01, 'a stub arrow head never pokes out behind its tail');

const bb = arrowBounds({ ...straight, x2: 100, curve: [50, -60, 50, 60] });
assert.ok(bb.y < -20 && bb.y + bb.h > 20, 'bounds include the curve');

/* ---- ink ---- */
const flat = [];
for (let i = 0; i <= 30; i++) flat.push(i * 4, Math.sin(i / 5) * 10, 0.5 + 0.5 * Math.sin(i / 7));
const outline = inkStrokeOutline(flat, 6);
assert.equal(outline[0][0], 'M');
assert.equal(outline.at(-1)[0], 'Z', 'ink outlines are closed shapes');
assert.equal(outline.filter(c => c[0] === 'A').length, 2, 'both ends get a round cap');
const inkBox = extents(outline);
assert.ok(inkBox.x1 >= -6 && inkBox.x2 <= 126, 'the outline hugs the stroke');

// Taper: the nib at the ends is narrower than in the middle.
const radiiProbe = inkStrokeOutline([0, 0, 1, 50, 0, 1, 100, 0, 1, 150, 0, 1, 200, 0, 1], 10);
const caps = radiiProbe.filter(c => c[0] === 'A').map(c => c[3]);
assert.ok(caps.every(r => r < 5), `entry and exit taper below the full nib (${caps})`);

const dot = inkStrokeOutline([5, 5, 1], 4);
assert.equal(dot[1][0], 'A', 'a single tap leaves a dot');

assert.deepEqual(tubeOutline([], []), []);

const thin = thinStroke([0, 0, 1, 0.1, 0, 1, 0.2, 0, 1, 5, 0, 1, 5.1, 0, 1], 1);
assert.deepEqual(thin, [0, 0, 1, 5, 0, 1, 5.1, 0, 1], 'thinning drops sub-threshold points but keeps both ends');

const ib = inkPointsBounds([[0, 0, 1, 10, 20, 1], [-5, 3, 1]], 2);
assert.deepEqual(ib, { x: -7, y: -2, w: 19, h: 24 });
assert.equal(inkPointsBounds([], 0), null);

near(distanceToPolyline([0, 0, 1, 10, 0, 1], 5, 2, 3), 2, 1e-9);

/* ---- pressure ---- */
let p = 0.6;
for (let i = 0; i < 40; i++) p = simulatedPressure(p, 60);
assert.ok(p < 0.4, 'fast mouse travel thins the nib');
for (let i = 0; i < 40; i++) p = simulatedPressure(p, 1);
assert.ok(p > 0.95, 'slow travel swells it back');
assert.ok(penPressure(0) > 0.15, 'a feather-light pen touch still draws');
near(penPressure(1), 1, 1e-9);

/* ---- halo ---- */
assert.match(annotationHaloColor('#000000'), /255,255,255/, 'dark marks get a light outline');
assert.match(annotationHaloColor('#ffffff'), /^rgba\(10,/, 'light marks get a dark outline');
assert.match(annotationHaloColor('#ffd60a'), /^rgba\(10,/, 'yellow is light');
assert.match(annotationHaloColor('#ff4d4f'), /255,255,255/, 'red reads as dark enough for a light outline');
assert.match(annotationHaloColor('not a colour'), /255,255,255/);

/* ---- the app wires it ---- */
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
for (const id of ['inkPenBtn', 'inkHighlightBtn', 'sAnnotSwatches', 'sArrowHeads', 'sArrowStyle', 'sAnnotOutline', 'sAnnotThinner', 'sAnnotThicker']) {
  assert.equal((html.match(new RegExp(`id=["']${id}["']`, 'g')) ?? []).length, 1, `${id} is present once`);
}
assert.match(html, /from '\.\/scripts\/annotation-geometry\.mjs'/, 'index.html imports the geometry module');
assert.match(html, /if \(it\.kind === 'ink'\) \{/, 'normalizeItem has an ink branch, or ink would load as a broken image');
assert.match(html, /isArrowItem\(it\) \|\| \(isInkItem\(it\) && it\.strokes\.length\)/, 'board loads keep ink items');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.ok(pkg.build.files.includes('scripts/annotation-geometry.mjs'), 'the geometry module ships in the build');

console.log('annotation geometry tests passed');
