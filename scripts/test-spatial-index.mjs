import assert from 'node:assert/strict';
import { createSpatialIndex } from './spatial-index.mjs';

/* Deterministic pseudo-random so a failure reproduces. */
let seed = 20260904;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

/* Board items: rects with rotation, arrows, and groups with children. The
   bounds callback is the rotated axis-aligned box, as the renderer computes. */
function rotatedAABB(it) {
  const a = (it.rot || 0) * Math.PI / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  const hw = it.w / 2, hh = it.h / 2;
  const ax = c * hw + s * hh, ay = s * hw + c * hh;
  const cx = it.x + hw, cy = it.y + hh;
  return { x: cx - ax, y: cy - ay, w: ax * 2, h: ay * 2 };
}
const boundsFor = it => it.kind === 'arrow'
  ? { x: Math.min(it.x1, it.x2) - 8, y: Math.min(it.y1, it.y2) - 8, w: Math.abs(it.x2 - it.x1) + 16, h: Math.abs(it.y2 - it.y1) + 16 }
  : rotatedAABB(it);
const isGroup = it => it.kind === 'group';

function makeBoard(n, groupsCount = 5) {
  const items = [];
  for (let g = 0; g < groupsCount; g++) items.push({ id: `g${g}`, kind: 'group', x: 0, y: 0, w: 40, h: 40 });
  for (let i = 0; i < n; i++) {
    const kind = i % 17 === 0 ? 'arrow' : i % 5 === 0 ? 'note' : 'image';
    const it = kind === 'arrow'
      ? { id: `a${i}`, kind, x1: rand() * 20000, y1: rand() * 20000, x2: rand() * 20000, y2: rand() * 20000 }
      : { id: `i${i}`, kind, x: rand() * 20000 - 5000, y: rand() * 20000 - 5000, w: 50 + rand() * 900, h: 50 + rand() * 900, rot: i % 3 ? 0 : rand() * 360 };
    if (kind !== 'arrow' && i % 4 === 0) it.groupId = `g${i % groupsCount}`;
    items.push(it);
  }
  return items;
}

function brute(items, x, y, w, h) {
  return items.filter(it => !isGroup(it)).filter(it => {
    const b = boundsFor(it);
    return b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y;
  });
}
function brutePoint(items, x, y) {
  return items.filter(it => !isGroup(it)).filter(it => {
    const b = boundsFor(it);
    return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  }).reverse();
}

/* --- queries agree with brute force, in z order --- */
{
  let items = makeBoard(1200);
  const index = createSpatialIndex({ items: () => items, bounds: boundsFor, isGroup });
  for (let q = 0; q < 300; q++) {
    const x = rand() * 22000 - 6000, y = rand() * 22000 - 6000, w = rand() * 4000, h = rand() * 4000;
    const got = index.queryRect(x, y, w, h);
    const want = brute(items, x, y, w, h);
    assert.deepEqual(got.map(i => i.id), want.map(i => i.id), `rect query ${q} matches brute force in z order`);
  }
  for (let q = 0; q < 300; q++) {
    const x = rand() * 22000 - 6000, y = rand() * 22000 - 6000;
    const got = index.queryPoint(x, y);
    const want = brutePoint(items, x, y);
    assert.deepEqual(got.map(i => i.id), want.map(i => i.id), `point query ${q} matches brute force, topmost first`);
  }
  assert.equal(index.stats().rebuilds, 1, 'six hundred queries on a stable board rebuild once');

  // A viewport far larger than the board falls back to a scan and still agrees.
  const everything = index.queryRect(-1e7, -1e7, 2e7, 2e7);
  assert.equal(everything.length, items.filter(it => !isGroup(it)).length, 'a huge rect returns every non-group item');
  assert.deepEqual(everything.map(i => i.id), items.filter(it => !isGroup(it)).map(i => i.id), 'in z order');
  assert.deepEqual(index.queryRect(1e9, 1e9, 10, 10), [], 'a rect outside the content is empty');
  assert.deepEqual(index.queryPoint(1e9, 1e9), [], 'a point outside the content is empty');
}

/* --- groups: children and their union bounds --- */
{
  const items = makeBoard(200, 3);
  const index = createSpatialIndex({ items: () => items, bounds: boundsFor, isGroup });
  assert.deepEqual(index.groups().map(g => g.id), ['g0', 'g1', 'g2'], 'groups are listed in z order');
  for (const gid of ['g0', 'g1', 'g2']) {
    const want = items.filter(it => it.groupId === gid);
    assert.deepEqual(index.children(gid).map(i => i.id), want.map(i => i.id), `children of ${gid} in z order`);
    const cb = index.childrenBounds(gid);
    const x1 = Math.min(...want.map(i => boundsFor(i).x)), y1 = Math.min(...want.map(i => boundsFor(i).y));
    const x2 = Math.max(...want.map(i => boundsFor(i).x + boundsFor(i).w)), y2 = Math.max(...want.map(i => boundsFor(i).y + boundsFor(i).h));
    assert.deepEqual(cb, { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, `children bounds of ${gid}`);
  }
  assert.deepEqual(index.children('nope'), [], 'an unknown group has no children');
  assert.equal(index.childrenBounds('nope'), null);
  const copy = index.children('g0');
  copy.length = 0;
  assert.ok(index.children('g0').length > 0, 'children() returns a copy');
  const cb = index.contentBounds();
  const all = items.filter(it => !isGroup(it)).map(boundsFor);
  assert.equal(cb.x, Math.min(...all.map(b => b.x)), 'content bounds are the union of non-group boxes');
  assert.equal(index.boundsOf(items[0]), null, 'a group has no cached box');
  assert.deepEqual(index.boundsOf(items[5]), boundsFor(items[5]), 'an item box is the bounds callback result');
}

/* --- staleness: invalidate, replace, grow, reorder --- */
{
  let items = makeBoard(50, 1);
  const index = createSpatialIndex({ items: () => items, bounds: boundsFor, isGroup });
  const it = items.find(i => i.kind === 'image');
  it.rot = 0;
  index.queryPoint(it.x + 1, it.y + 1);
  assert.ok(index.queryPoint(it.x + 1, it.y + 1).includes(it), 'baseline hit');
  it.x += 100000;
  assert.ok(index.queryPoint(it.x + 1, it.y + 1).length === 0 || !index.queryPoint(it.x + 1, it.y + 1).includes(it), 'moved without a signal: stale, by design');
  index.invalidate();
  assert.ok(index.queryPoint(it.x + 1, it.y + 1).includes(it), 'after invalidate() the moved item is found at its new place');

  const before = index.stats().rebuilds;
  items.push({ id: 'late', kind: 'image', x: 500000, y: 500000, w: 10, h: 10, rot: 0 });
  assert.ok(index.queryPoint(500001, 500001).some(i => i.id === 'late'), 'a pushed item is found');
  assert.equal(index.stats().rebuilds, before + 1, 'growth rebuilt once');

  items = items.filter(i => i.id !== 'late');
  assert.deepEqual(index.queryPoint(500001, 500001), [], 'a replaced array drops the removed item');

  // In-place reorder keeps identity and length but changes z; a hit at a
  // stale position rebuilds and comes back in the new order.
  const a = items.find(i => i.kind === 'image' && !i.groupId);
  const b = items.find(i => i.kind === 'image' && !i.groupId && i !== a);
  Object.assign(b, { x: a.x, y: a.y, w: a.w, h: a.h, rot: 0 });
  a.rot = 0;
  index.invalidate();
  let hits = index.queryPoint(a.x + 1, a.y + 1);
  const topBefore = hits[0];
  items.reverse();
  hits = index.queryPoint(a.x + 1, a.y + 1);
  assert.notEqual(hits[0], topBefore, 'after an in-place reverse the other one is on top');
  assert.equal(hits[0], items.indexOf(a) > items.indexOf(b) ? a : b);
}

/* --- memo caches until the next rebuild --- */
{
  const items = makeBoard(30, 1);
  const index = createSpatialIndex({ items: () => items, bounds: boundsFor, isGroup });
  let computed = 0;
  const ids = () => index.memo('imageIds', arr => { computed++; return new Set(arr.filter(i => i.kind === 'image').map(i => i.id)); });
  assert.equal(ids(), ids(), 'the same value comes back');
  assert.equal(computed, 1, 'computed once');
  index.invalidate();
  ids();
  assert.equal(computed, 2, 'recomputed after a rebuild');
}

/* --- defensive --- */
{
  assert.throws(() => createSpatialIndex({ bounds: () => null }), TypeError);
  assert.throws(() => createSpatialIndex({ items: () => [] }), TypeError);
  const empty = createSpatialIndex({ items: () => [], bounds: boundsFor, isGroup });
  assert.deepEqual(empty.queryRect(0, 0, 10, 10), []);
  assert.equal(empty.contentBounds(), null);
  const holes = createSpatialIndex({ items: () => [null, { id: 'x', kind: 'image', x: 0, y: 0, w: 10, h: 10 }, { id: 'nan', kind: 'image', x: NaN, y: 0, w: 1, h: 1 }], bounds: boundsFor, isGroup });
  assert.deepEqual(holes.queryPoint(5, 5).map(i => i.id), ['x'], 'holes and unplaceable items are skipped');
}

console.log('spatial index tests passed');
