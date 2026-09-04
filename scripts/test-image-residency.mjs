import { createImageResidencyController } from './image-residency.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const closed = [];
const list = [
  { id: 'a', w: 10, h: 10, bitmap: { id: 'a' } },
  { id: 'b', w: 10, h: 10, bitmap: { id: 'b' } },
  { id: 'c', w: 10, h: 10, bitmap: { id: 'c' } },
];
const ctl = createImageResidencyController({
  maxFullPixels: 200,
  records: () => list,
  closeBitmap: bitmap => closed.push(bitmap.id),
});

ctl.touch(list[0]);
ctl.touch(list[1]);
ctl.touch(list[2]);
ctl.pin(list[0]);
ctl.evict();
assert(list[0].bitmap, 'pinned bitmap retained');
assert(!list[1].bitmap, 'oldest unpinned bitmap evicted');
assert(list[2].bitmap, 'newer bitmap retained within budget');
assert(closed.join(',') === 'b', 'close callback receives evicted bitmap');

list[1].bitmap = { id: 'b2' };
ctl.touch(list[1]);
ctl.evict({ protect: list[2] });
assert(!list[1].bitmap, 'protect excludes record from eviction');
assert(list[2].bitmap, 'protected bitmap remains');

ctl.unpin(list[0]);
assert(ctl.close(list[0]), 'unpinned bitmap can close explicitly');
assert(ctl.stats().decodedCount === 1, 'stats reflect decoded working set');

/* --- owner-side protection: what a recent frame drew is not an LRU victim --- */
{
  const drawn = new Set(['x', 'y']);
  const closedIds = [];
  const records = [
    { id: 'x', w: 10, h: 10, bitmap: {} },   // oldest, but on screen
    { id: 'y', w: 10, h: 10, bitmap: {} },   // on screen
    { id: 'z', w: 10, h: 10, bitmap: {} },   // newest, off screen
  ];
  const guarded = createImageResidencyController({
    maxFullPixels: 200,
    records: () => records,
    closeBitmap: () => closedIds.push('closed'),
    isProtected: record => drawn.has(record.id),
  });
  guarded.touch(records[0]);
  guarded.touch(records[1]);
  guarded.touch(records[2]);
  assert(guarded.stats().protectedCount === 2, 'stats count protected bitmaps');
  guarded.evict();
  assert(records[0].bitmap && records[1].bitmap, 'drawn bitmaps survive eviction even when they are the LRU victims');
  assert(!records[2].bitmap, 'the unprotected bitmap is the one reclaimed');
  assert(closedIds.length === 1, 'exactly one bitmap closed');

  // Over cap with everything protected: stay over cap rather than blank the screen.
  records[2].bitmap = {};
  guarded.touch(records[2]);
  drawn.add('z');
  const before = guarded.stats().fullPixels;
  assert(guarded.evict() === 0, 'a fully protected set is not evicted');
  assert(guarded.stats().fullPixels === before, 'protected pixels are all still resident');

  // Protection released (the frame window passed): LRU order applies again.
  drawn.clear();
  guarded.evict();
  assert(guarded.stats().fullPixels <= 200, 'once unprotected, eviction returns the pool to its cap');
  assert(records[2].bitmap, 'the most recently used bitmap is the one kept');
}

/* --- a function-valued cap is read live, so a shrinking budget evicts --- */
{
  let cap = 300;
  const records = [
    { id: 'p', w: 10, h: 10, bitmap: {} },
    { id: 'q', w: 10, h: 10, bitmap: {} },
    { id: 'r', w: 10, h: 10, bitmap: {} },
  ];
  const live = createImageResidencyController({
    maxFullPixels: () => cap,
    records: () => records,
    closeBitmap: () => {},
  });
  records.forEach(r => live.touch(r));
  assert(live.evict() === 0, 'within a live cap nothing is evicted');
  cap = 100;
  assert(live.evict() === 2, 'a lowered live cap evicts down to it');
  assert(records[2].bitmap && !records[0].bitmap && !records[1].bitmap, 'LRU order decides which survive');
  cap = 0;
  assert(live.evict() === 0, 'the last decoded bitmap is kept even at a zero cap');
}

console.log('image residency tests passed');
