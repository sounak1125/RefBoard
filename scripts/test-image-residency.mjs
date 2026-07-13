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

console.log('image residency tests passed');
