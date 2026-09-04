import assert from 'node:assert/strict';
import { createItemIndex } from './item-index.mjs';

const make = n => Array.from({ length: n }, (_, i) => ({ id: `it-${i}`, x: i }));

/* --- parity with Array.find --- */
{
  let items = make(500);
  const byId = createItemIndex(() => items);
  for (let i = 0; i < items.length; i += 37) {
    assert.equal(byId(`it-${i}`), items.find(x => x.id === `it-${i}`), `hit ${i} returns the same object find() would`);
  }
  assert.equal(byId('nope'), undefined, 'a missing id is undefined');
  assert.equal(byId(null), undefined, 'a null id is undefined');
  assert.equal(byId(undefined), undefined, 'an undefined id is undefined');
  assert.equal(byId.stats().rebuilds, 1, 'a stable array is indexed once');

  for (let i = 0; i < 10000; i++) byId(`it-${i % 500}`);
  assert.equal(byId.stats().rebuilds, 1, 'ten thousand hits on a stable array do not rebuild');
  for (let i = 0; i < 1000; i++) byId(`missing-${i}`);
  assert.equal(byId.stats().rebuilds, 1, 'misses on a stable array do not rebuild either');
}

/* --- every mutation shape the renderer uses --- */
{
  let items = make(10);
  const byId = createItemIndex(() => items);
  assert.ok(byId('it-3'), 'baseline hit');

  // Wholesale reassignment (filter / map / spread / []).
  items = items.filter(x => x.id !== 'it-3');
  assert.equal(byId('it-3'), undefined, 'reassigned array: a removed item is gone');
  assert.equal(byId('it-4'), items[3], 'reassigned array: survivors are found at their new positions');

  const replaced = make(10).map(x => ({ ...x, x: x.x + 100 }));
  items = replaced;
  assert.equal(byId('it-3'), replaced[3], 'a fresh array of new objects with the same ids returns the new objects');
  assert.equal(byId('it-3').x, 103, 'not a stale object from the previous array');

  // push (the only in-place growth the renderer uses).
  const pushed = { id: 'late', x: 1 };
  items.push(pushed);
  assert.equal(byId('late'), pushed, 'a pushed item is found');
  items.push({ id: 'a' }, { id: 'b' });
  assert.equal(byId('b')?.id, 'b', 'a multi-push is found');

  // splice shrinks the length.
  items.splice(0, 2);
  assert.equal(byId('it-0'), undefined, 'a spliced-out item is gone');
  assert.equal(byId('it-2'), items[0], 'items after a splice are found at their shifted positions');

  // In-place sort keeps identity and length but moves everything.
  const before = byId.stats().rebuilds;
  items.sort((p, q) => (q.id > p.id ? 1 : -1));
  const found = byId('it-5');
  assert.equal(found, items[items.indexOf(found)], 'an in-place sort still returns the right object');
  assert.equal(found.id, 'it-5');
  assert.equal(byId.stats().rebuilds, before + 1, 'a position miss after a sort rebuilds exactly once');
  assert.equal(byId('it-7').id, 'it-7', 'subsequent hits use the rebuilt positions');

  // Same-id replacement at a fixed length: the new object is what comes back.
  const pos = items.findIndex(x => x.id === 'it-7');
  const fresh = { id: 'it-7', x: 'fresh' };
  items[pos] = fresh;
  assert.equal(byId('it-7'), fresh, 'a same-id replacement returns the new object, never the old one');

  // Reset to empty and back.
  items = [];
  assert.equal(byId('it-7'), undefined, 'an emptied board finds nothing');
  items = make(3);
  assert.equal(byId('it-1'), items[1], 'a repopulated board is found');
}

/* --- duplicate ids resolve to the first, as find() did --- */
{
  const first = { id: 'dup', which: 'first' };
  const items = [first, { id: 'dup', which: 'second' }];
  const byId = createItemIndex(() => items);
  assert.equal(byId('dup'), first, 'the first of two items with the same id wins');
}

/* --- defensive inputs --- */
{
  let items = null;
  const byId = createItemIndex(() => items);
  assert.equal(byId('x'), undefined, 'a non-array items() is a miss, not a throw');
  items = [null, undefined, { id: 'ok' }, { noId: true }];
  assert.equal(byId('ok')?.id, 'ok', 'holes and id-less entries are skipped');
  assert.throws(() => createItemIndex(), TypeError, 'items() is required');
}

console.log('item index tests passed');
