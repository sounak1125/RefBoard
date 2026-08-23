import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  const brace = html.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(`${name} should have a complete body`);
}

// Every snap constant is a single-line declaration, so the tuning numbers under
// test are the ones the app actually ships rather than copies that can drift.
function extractConst(name) {
  const re = new RegExp(`^\\s*const ${name} = .*$`, 'm');
  const m = html.match(re);
  assert.ok(m, `const ${name} should exist on one line`);
  return m[0].trim();
}

const CONSTS = [
  'SNAP_PULL_IN_FLUSH_PX', 'SNAP_PULL_IN_ALIGN_PX', 'SNAP_RELEASE_MULT',
  'SNAP_CLASS_BIAS_PX', 'SNAP_ZERO_EPS_PX', 'SNAP_ZERO_EPS_BOARD_MIN',
  'SNAP_FLUSH_MIN_OVERLAP_FRAC', 'SNAP_ALIGN_RANGE_PX',
  'SNAP_TARGET_CULL_MARGIN_PX', 'SNAP_TARGET_MAX', 'SNAP_ROT_TOL_DEG',
  'SNAP_SESSION_ZOOM_DRIFT', 'snapRadiiCache', 'SNAP_EDGES_ALL', 'SNAP_NONE',
  'SNAP_GUIDE_OVERHANG_PX',
].map(extractConst).join('\n');

const FUNCS = [
  'rotRad', 'rotateVec', 'localToBoardRect', 'boardToLocalRect',
  'itemCorners', 'boundsOf',
  'snapPullInBoard', 'snapRadii', 'isAxisAlignedItem',
  'snapBoxOfItem', 'snapBoxOfItems', 'snapBoxCenterDist2',
  'buildSnapSession', 'snapSessionValid',
  'collectAxisCandidates', 'pushSnapCandidate', 'pickAxisCandidate', 'solveSnap',
  'updateSnapGuides',
].map(extractFunction).join('\n');

const context = {};
vm.runInNewContext(`
  const state = { view: { tx: 0, ty: 0, s: 1 }, items: [] };
  let mode = { type: 'move' };
  const snapGuides = [];
  const snapCandBufX = [], snapCandBufY = [];
  const boardSize = () => ({ w: 1400, h: 900 });
  const isGroupItem = it => it?.kind === 'group';
  const isArrowItem = it => it?.kind === 'arrow';
  const itemUiRect = it => ({ x: it.x, y: it.y, w: it.w, h: it.h });
  ${CONSTS}
  ${FUNCS}
  this.state = state;
  this.snapGuides = snapGuides;
  this.setMode = m => { mode = m; };
  this.SNAP_EDGES_ALL = SNAP_EDGES_ALL;
  this.SNAP_TARGET_MAX = SNAP_TARGET_MAX;
  this.snapRadii = snapRadii;
  this.snapPullInBoard = snapPullInBoard;
  this.isAxisAlignedItem = isAxisAlignedItem;
  this.snapBoxOfItem = snapBoxOfItem;
  this.snapBoxOfItems = snapBoxOfItems;
  this.buildSnapSession = buildSnapSession;
  this.snapSessionValid = snapSessionValid;
  this.collectAxisCandidates = collectAxisCandidates;
  this.solveSnap = solveSnap;
  this.updateSnapGuides = updateSnapGuides;
`, context);

const img = (id, x, y, w, h, extra = {}) => ({ id, kind: 'image', x, y, w, h, rot: 0, ...extra });
const box = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });

const T1 = img('t1', 200, 0, 100, 100);    // 200..300 x 0..100
const T2 = img('t2', 200, 600, 100, 100);  // 200..300 x 600..700
const T3 = img('t3', 100, 150, 92, 100);   // 100..192 x 150..250, cx = 146

// Drives the engine exactly as the drag loop does: a board-space moving box
// against a freshly built target session.
function solve(mv, targets, sticky = null, edges = context.SNAP_EDGES_ALL) {
  context.state.items = targets;
  const sess = context.buildSnapSession(new Set(), mv);
  return context.solveSnap(mv, sess.boxes, sticky, edges, edges, context.snapRadii());
}

function candidates(axis, mv, targets) {
  context.state.items = targets;
  const sess = context.buildSnapSession(new Set(), mv);
  const out = context.collectAxisCandidates(axis, mv, sess.boxes, context.snapRadii(), context.SNAP_EDGES_ALL, []);
  return out.map(c => ({ ...c }));
}

/* --- A: flush right-to-left is the signature snap --- */
{
  const r = solve(box(95, 20, 195, 80), [T1]);
  assert.equal(r.dx, 5, 'right edge should be pulled flush onto the target left edge');
  assert.equal(r.x.cls, 'flush');
  assert.equal(r.x.movingEdge, 'max');
  assert.equal(r.x.targetEdge, 'min');
  assert.equal(r.x.targetId, 't1');
}

/* --- B: perpendicular gating --- */
{
  const mv = box(195, 900, 295, 1000);
  const r = solve(mv, [T1, T2]);
  assert.equal(r.x.targetId, 't2', 'a target 800px away perpendicular must not beat one 200px away');
  const cx = candidates('x', mv, [T1, T2]);
  assert.ok(cx.length > 0, 'the nearer target should still produce candidates');
  assert.ok(cx.every(c => c.targetId === 't2'), 'the far target must be gated out entirely');
  assert.ok(cx.every(c => c.cls !== 'flush'), 'flush needs real perpendicular overlap, and there is none here');
}

/* --- C: flush wins a tie against a centre --- */
{
  const r = solve(box(98, 20, 198, 80), [T1, T3]);
  assert.equal(r.dx, 2);
  assert.equal(r.x.cls, 'flush', 'at equal distance flush should beat a centre alignment');
}

/* --- C2: ...but not against a markedly closer centre --- */
{
  const r = solve(box(95, 20, 195, 80), [T1, T3]);
  assert.equal(r.dx, 1);
  assert.equal(r.x.cls, 'center', 'a 1px centre must still beat a 5px flush');
}

/* --- D: an exact alignment is never destroyed (the old `if (off)` bug) --- */
{
  const mv = box(94, 20, 198, 80);   // centre exactly on T3.cx, flush 2px away
  const cx = candidates('x', mv, [T1, T3]);
  const flush = cx.find(c => c.cls === 'flush');
  assert.ok(flush && flush.dist === 2, 'the competing flush candidate should exist at 2px');
  const r = solve(mv, [T1, T3]);
  assert.equal(r.dx, 0, 'an already-satisfied axis must not be dragged off by a nearer candidate');
  assert.equal(r.x.cls, 'center');
}

/* --- E: hysteresis, engage narrow and release wide --- */
{
  const sticky = { x: null, y: null };
  const engaged = solve(box(95, 20, 195, 80), [T1], sticky);
  assert.equal(engaged.dx, 5, 'engages inside the pull-in radius');
  assert.ok(sticky.x, 'engagement should be recorded');

  const held = solve(box(85, 20, 185, 80), [T1], sticky);
  assert.equal(held.dx, 15, 'an engaged snap holds out to the wider release radius');

  const released = solve(box(75, 20, 175, 80), [T1], sticky);
  assert.equal(released.x, null, 'past the release radius the axis lets go');
  assert.equal(sticky.x, null, 'and the engagement is cleared');

  const cold = solve(box(85, 20, 185, 80), [T1], { x: null, y: null });
  assert.equal(cold.x, null, '15px is beyond pull-in, so it must not engage from cold');
}

/* --- F: rotated items offer their centre and nothing else --- */
{
  assert.equal(context.isAxisAlignedItem({ rot: 30 }), false);
  assert.equal(context.isAxisAlignedItem({ rot: 90 }), true);
  assert.equal(context.isAxisAlignedItem({ rot: 0.4 }), true, 'float residue from repeated rotates still counts as square');

  const tilted = context.snapBoxOfItem(img('r', 0, 0, 100, 100, { rot: 30 }));
  assert.ok(tilted, 'a rotated item is still a snap participant');
  assert.equal(tilted.centerOnly, true, 'but only through its centre');

  const spun = context.snapBoxOfItem(img('r90', 0, 0, 100, 50, { rot: 90 }));
  assert.equal(spun.centerOnly, undefined, 'a right angle is square, so its AABB is the real rect');
  assert.equal(spun.x2 - spun.x1, 50, 'a 90-degree item presents swapped extents');
  assert.equal(spun.y2 - spun.y1, 100);
  assert.equal((spun.x1 + spun.x2) / 2, 50, 'rotation is about the centre');
  assert.equal((spun.y1 + spun.y2) / 2, 25);
}

/* --- F2: a rotated TARGET lends a centre line, never an edge --- */
{
  // Centred on (150, 150) whatever the angle, because rotation is about centre.
  const tiltedTarget = img('rt', 100, 100, 100, 100, { rot: 30 });
  const mv = box(95, 100, 195, 200);   // centre x 145, 5 short of the target centre
  const cs = candidates('x', mv, [tiltedTarget]);
  assert.ok(cs.length > 0, 'a rotated neighbour should still produce a candidate');
  assert.ok(cs.every(c => c.cls === 'center'), `only centre candidates from a rotated target (got ${cs.map(c => c.cls).join(',')})`);
  const r = solve(mv, [tiltedTarget]);
  assert.equal(r.dx, 5, 'and that centre line should actually pull');
  assert.equal(r.x.cls, 'center');
}

/* --- F3: a rotated MOVING box likewise aligns only by centre --- */
{
  const rotatedMover = box(95, 100, 195, 200);
  rotatedMover.centerOnly = true;
  const cs = candidates('x', rotatedMover, [T1]);
  assert.ok(cs.every(c => c.cls === 'center'), 'a rotated selection must not claim edges it does not have');
}

/* --- F4: one rotated member must not cost the whole selection its edges --- */
{
  const square = img('sq', 0, 0, 100, 100);
  const tilted = img('tl', 200, 0, 100, 100, { rot: 30 });
  const mixed = context.snapBoxOfItems([square, tilted]);
  assert.equal(mixed.centerOnly, undefined, 'a mixed selection keeps real edges');
  assert.equal(mixed.x2, 100, 'and takes them from the square members only');

  const allTilted = context.snapBoxOfItems([tilted]);
  assert.equal(allTilted.centerOnly, true, 'an all-rotated selection falls back to centre alignment');
}

/* --- G: group frames snap by their children, not their padded chrome --- */
{
  const group = { id: 'g1', kind: 'group', x: -16, y: -16, w: 132, h: 132, rot: 0 };
  const child = img('c1', 0, 0, 100, 100, { groupId: 'g1' });
  assert.equal(context.snapBoxOfItem(group), null, 'a group frame is chrome, not an edge');
  const gb = context.snapBoxOfItems([group, child]);
  // Per-field: values built inside the vm realm carry that realm's prototypes,
  // so deepStrictEqual rejects them on identity alone.
  for (const [k, want] of [['x1', 0], ['y1', 0], ['x2', 100], ['y2', 100]]) {
    assert.equal(gb[k], want, `a dragged group must present its children exactly, with no padding (${k})`);
  }
}

/* --- H: arrows carry an arrowhead pad, so they are not edges either --- */
assert.equal(context.snapBoxOfItem({ id: 'a1', kind: 'arrow', x: 0, y: 0, w: 10, h: 10 }), null);

/* --- I: idempotent, which is what stops per-frame oscillation --- */
{
  const mv = box(95, 20, 195, 80);
  const r = solve(mv, [T1]);
  const settled = box(mv.x1 + r.dx, mv.y1 + r.dy, mv.x2 + r.dx, mv.y2 + r.dy);
  const again = solve(settled, [T1], { x: null, y: null });
  assert.equal(again.dx, 0, 're-solving a settled box must not move it');
  assert.equal(again.dy, 0);
}

/* --- J: viewport cull and hard cap --- */
{
  const many = [];
  for (let i = 0; i < 5000; i++) many.push(img(`m${i}`, (i % 100) * 12, Math.floor(i / 100) * 12, 10, 10));
  context.state.items = many;
  const sess = context.buildSnapSession(new Set(), box(0, 0, 10, 10));
  assert.ok(sess.boxes.length <= context.SNAP_TARGET_MAX, `target count capped, got ${sess.boxes.length}`);

  context.state.items = [T1, img('far', 90000, 90000, 10, 10)];
  const culled = context.buildSnapSession(new Set(), box(0, 0, 10, 10));
  // Array.from rehomes the vm-realm array so deepStrictEqual can compare it.
  assert.deepEqual(Array.from(culled.boxes, b => b.id), ['t1'], 'items far outside the viewport are culled');
}

/* --- K: the edge-to-centre cross pairs are gone --- */
{
  for (const axis of ['x', 'y']) {
    const cs = candidates(axis, box(95, 20, 195, 80), [T1, T2, T3]);
    for (const c of cs) {
      assert.equal(c.movingEdge === 'center', c.targetEdge === 'center',
        `${axis}: edge-to-centre cross pairs must not be emitted (${c.movingEdge}->${c.targetEdge})`);
    }
  }
}

/* --- L: the feel is zoom-invariant --- */
{
  context.state.view.s = 1;
  const a = context.snapPullInBoard('flush');
  const alignA = context.snapRadii().alignRangeBoard;
  context.state.view.s = 2;
  const b = context.snapPullInBoard('flush');
  const alignB = context.snapRadii().alignRangeBoard;
  context.state.view.s = 1;
  assert.equal(b, a / 2, 'the board-space pull radius halves when zoom doubles');
  assert.equal(alignB, alignA / 2);
}

/* --- session invalidation --- */
{
  context.state.items = [T1];
  const sess = context.buildSnapSession(new Set(), box(0, 0, 10, 10));
  assert.equal(context.snapSessionValid(sess), true);
  context.setMode({ type: 'move' });   // a new gesture
  assert.equal(context.snapSessionValid(sess), false, 'a new gesture must invalidate the cached targets');
  assert.equal(context.snapSessionValid(null), false);
}

/* --- guides span the pair, not the viewport --- */
{
  // y 25..55 overlaps T1 enough for flush but sits clear of its 0/50/100 lines,
  // so exactly one axis engages.
  const mv = box(95, 25, 195, 55);
  const r = solve(mv, [T1]);
  assert.equal(r.dx, 5);
  assert.equal(r.y, null, 'the y axis should find nothing here');
  context.updateSnapGuides(r, mv);
  assert.equal(context.snapGuides.length, 1, 'one engaged axis draws one guide');
  const g = context.snapGuides[0];
  assert.equal(g.axis, 'x');
  assert.equal(g.line, 200, 'the guide sits on the snapped line');
  assert.equal(g.cls, 'flush');
  // union of moving y (25..55) and T1 y (0..100), plus a 12px overhang
  assert.equal(g.a, -12);
  assert.equal(g.b, 112);
}

/* --- both axes can engage at once, and an incidental alignment is held at
       zero offset rather than being broken --- */
{
  const mv = box(95, 20, 195, 80);   // centre y 50 already matches T1 centre y
  const r = solve(mv, [T1]);
  assert.equal(r.dx, 5, 'x still snaps flush');
  assert.equal(r.dy, 0, 'an incidentally satisfied y axis is held, not moved');
  assert.equal(r.y.cls, 'center');
  context.updateSnapGuides(r, mv);
  assert.equal(context.snapGuides.length, 2, 'each engaged axis draws its own guide');
  assert.deepEqual(Array.from(context.snapGuides, g => g.axis), ['x', 'y']);
}

/* --- source-level guarantees --- */
assert.doesNotMatch(html, /snapToGrid\(/, 'grid snapping must be gone');
assert.doesNotMatch(html, /axisSnapOffset\(/, 'the old offset helper must be gone');
assert.doesNotMatch(html, /snapTargets\(/, 'the per-frame O(n) target scan must be gone');
assert.doesNotMatch(html, /state\.snapEnabled/, 'snapping is an app setting now, not board state');
assert.match(html, /snapEnabled: true,/, 'object snapping should default on');
assert.match(html, /applyMoveSnap\(mode, e\.ctrlKey \|\| e\.metaKey\)/, 'the drag loop should call the new engine');
assert.match(html, /snapItemResize\(it, r, \{ edge: mode\.edge \}/, 'edge resize should snap');
assert.match(html, /snapItemResize\(it, r, \{ corner: mode\.corner \}/, 'corner resize should snap');
assert.match(html, /snapGroupResize\(mode\.orig, r, \{ edge: mode\.edge \}/, 'group edge resize should snap');
assert.match(html, /snapGroupResize\(mode\.orig, r, \{ corner: mode\.corner \}/, 'group corner resize should snap');
assert.match(html, /drawSnapGuides\(\);/, 'guides should be drawn');
assert.doesNotMatch(html, /Dots snap when moving or scaling/, 'the dot grid no longer snaps');

console.log('snap engine tests passed');
