import assert from 'node:assert/strict';
import {
  ABSENT, cloneData, sameData, snapshotBoard, diffSnapshots, applyDelta, estimateDeltaBytes, createBoardHistory,
} from './board-history.mjs';

let seed = 77;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = arr => arr[Math.floor(rand() * arr.length)];

const makeItem = (i, kind = 'image') => kind === 'note'
  ? { id: `n${i}`, kind, x: i * 10, y: 5, w: 200, h: 120, rot: 0, text: `note ${i}`, tags: ['a'], groupId: null }
  : { id: `i${i}`, kind: 'image', imgId: `img${i}`, x: i * 10, y: 0, w: 100, h: 80, rot: 0, flipX: false, crop: { l: 0, t: 0, r: 1, b: 1 }, tags: [], groupId: null };
const makeBoard = n => Array.from({ length: n }, (_, i) => makeItem(i, i % 4 === 0 ? 'note' : 'image'));
const props = () => ({ boardGray: false, gridAppearance: 'dots', tagColors: { a: '#f00' } });
// Canonical text: key order is not data, and a property removed then restored
// comes back at the end of its object.
const canon = v => Array.isArray(v) ? v.map(canon) : (v && typeof v === 'object')
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v;
const plain = items => JSON.stringify(canon(items));

/* --- clone and compare handle nested plain data --- */
{
  const it = makeItem(1);
  const c = cloneData(it);
  assert.deepEqual(c, it);
  assert.notEqual(c.crop, it.crop, 'nested objects are copied');
  c.crop.l = 0.5;
  assert.equal(it.crop.l, 0, 'the original is untouched');
  assert.equal(sameData(it, cloneData(it)), true);
  assert.equal(sameData({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), true);
  assert.equal(sameData({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] }), false);
  assert.equal(sameData({ a: 1 }, { a: 1, b: undefined }), false, 'a key that exists counts');
  assert.equal(sameData(NaN, NaN), true);
}

/* --- a delta reverses every kind of mutation exactly --- */
{
  const mutations = {
    move: items => { const it = pick(items); it.x += 17; it.y -= 3; },
    resize: items => { const it = pick(items); it.w *= 1.5; it.h *= 1.5; },
    rotate: items => { const it = pick(items); it.rot = (it.rot + 45) % 360; },
    crop: items => { const it = pick(items.filter(i => i.crop)); if (it) it.crop.l = rand(); },
    tag: items => { const it = pick(items.filter(i => Array.isArray(i.tags))); if (it) it.tags.push('t' + Math.floor(rand() * 100)); },
    text: items => { const it = pick(items.filter(i => i.kind === 'note')); if (it) it.text += '!'; },
    newProp: items => { const it = pick(items); it.gray = true; },
    dropProp: items => { const it = pick(items.filter(i => 'flipX' in i)); if (it) delete it.flipX; },
    add: items => { items.push(makeItem(1000 + Math.floor(rand() * 1e6))); },
    remove: items => { if (items.length > 2) items.splice(Math.floor(rand() * items.length), 1); },
    toFront: items => { if (items.length > 1) { const i = Math.floor(rand() * items.length); const [it] = items.splice(i, 1); items.push(it); } },
    reorderAll: items => { items.reverse(); },
    group: items => { const g = { id: 'g' + Math.floor(rand() * 1e6), kind: 'group', x: 0, y: 0, w: 40, h: 40 }; items.push(g); for (const it of items.slice(0, 3)) if (it.kind !== 'group') it.groupId = g.id; },
  };
  const names = Object.keys(mutations);
  for (let round = 0; round < 200; round++) {
    let items = makeBoard(12);
    const boardProps = props();
    const beforeText = plain(items);
    const before = snapshotBoard(items, boardProps);
    // One to four mutations per operation, like a real gesture that touches several things.
    const count = 1 + Math.floor(rand() * 4);
    const used = [];
    for (let k = 0; k < count; k++) { const name = pick(names); used.push(name); mutations[name](items); }
    if (round % 7 === 0) boardProps.boardGray = !boardProps.boardGray;
    const afterText = plain(items);
    const after = snapshotBoard(items, boardProps);
    const delta = diffSnapshots(before, after);
    if (beforeText === afterText && before.props === after.props) {
      assert.equal(delta, null, `no-op round ${round} (${used}) yields no delta`);
      continue;
    }
    assert.ok(delta, `round ${round} (${used}) yields a delta`);
    const bytes = estimateDeltaBytes(delta);
    assert.ok(bytes > 0 && bytes < afterText.length * 2 + 200, `delta is bounded by the board size (${bytes} vs ${afterText.length * 2})`);

    // Undo on the live objects.
    const liveIds = new Set(items.map(i => i.id));
    const undone = applyDelta({ items, props: boardProps }, delta, 'before');
    const restored = undone.items || items;
    assert.equal(plain(restored), beforeText, `round ${round} (${used}): undo restores the board exactly`);
    if (undone.props) Object.assign(boardProps, undone.props);
    assert.deepEqual(boardProps, JSON.parse(before.props), 'undo restores the props');
    for (const it of restored) if (liveIds.has(it.id)) assert.ok(items.includes(it) || undone.items, 'surviving items keep their identity');

    // Redo on the restored objects.
    const redone = applyDelta({ items: restored, props: boardProps }, delta, 'after');
    assert.equal(plain(redone.items || restored), afterText, `round ${round} (${used}): redo re-applies the board exactly`);
    if (redone.props) Object.assign(boardProps, redone.props);
    assert.deepEqual(boardProps, JSON.parse(after.props), 'redo restores the props');
  }
}

/* --- identity: unchanged and changed items are the same objects after apply --- */
{
  const items = makeBoard(5);
  const [a, b] = items;
  const before = snapshotBoard(items, {});
  b.x = 999;
  const delta = diffSnapshots(before, snapshotBoard(items, {}));
  assert.deepEqual(delta.changed.map(c => c.id), ['i1'], 'only the moved item is in the delta');
  assert.deepEqual(delta.changed[0].before, { x: 10 });
  assert.deepEqual(delta.changed[0].after, { x: 999 });
  assert.equal(delta.order, null, 'no order change recorded');
  const r = applyDelta({ items, props: {} }, delta, 'before');
  assert.equal(r.items, null, 'no new array when only properties changed');
  assert.equal(items[0], a);
  assert.equal(items[1], b, 'the changed item is the same object');
  assert.equal(b.x, 10);
  assert.deepEqual(r.changedIds, ['i1']);
}

/* --- ABSENT marks a property that only one side has --- */
{
  const items = [makeItem(1)];
  const before = snapshotBoard(items, {});
  delete items[0].flipX;
  items[0].fresh = 'yes';
  const delta = diffSnapshots(before, snapshotBoard(items, {}));
  const change = delta.changed[0];
  assert.equal(change.before.flipX, false);
  assert.equal(change.after.flipX, ABSENT);
  assert.equal(change.before.fresh, ABSENT);
  assert.equal(change.after.fresh, 'yes');
  applyDelta({ items, props: {} }, delta, 'before');
  assert.equal(items[0].flipX, false);
  assert.ok(!('fresh' in items[0]), 'a property that did not exist before is removed');
  assert.doesNotThrow(() => estimateDeltaBytes(delta), 'ABSENT serialises for the byte estimate');
}

/* --- the stacks --- */
{
  const items = makeBoard(6);
  const boardProps = props();
  const released = [];
  const history = createBoardHistory({
    snapshot: () => snapshotBoard(items, boardProps),
    limit: () => 4,
    byteBudget: () => 10_000_000,
    release: e => released.push(e),
  });
  const apply = (entry, dir) => { const r = applyDelta({ items, props: boardProps }, entry.delta, dir); if (r.items) { items.length = 0; items.push(...r.items); } if (r.props) Object.assign(boardProps, r.props); };

  history.begin();
  assert.equal(history.finalize(), null, 'an operation that changed nothing leaves no entry');
  assert.equal(history.undoStack.length, 0);

  history.begin();
  items[0].x = 500;
  history.begin();                          // next op: finalises the previous
  assert.equal(history.undoStack.length, 1, 'the first op became an entry at the second begin');
  items[1].x = 600;
  const e2 = history.undo();                // finalises the pending op, then pops it
  assert.ok(e2 && e2.delta.changed[0].id === 'i1', 'undo finalises the open op and returns it');
  apply(e2, 'before');
  assert.equal(items[1].x, 10);
  assert.equal(history.redoStack.length, 1);
  const e1 = history.undo();
  apply(e1, 'before');
  assert.equal(items[0].x, 0);
  assert.equal(history.undoStack.length, 0);
  assert.equal(history.redoStack.length, 2);

  const r1 = history.redo();
  apply(r1, 'after');
  assert.equal(items[0].x, 500, 'redo re-applies the first op');
  assert.equal(history.undoStack.length, 1);

  // A new op with a change clears redo; a no-op does not.
  history.begin();
  history.finalize();
  assert.equal(history.redoStack.length, 1, 'a no-op keeps redo');
  history.begin();
  items[2].x = 700;
  history.finalize();
  assert.equal(history.redoStack.length, 0, 'a real op clears redo');
  assert.equal(released.length, 1, 'the dropped redo entry was released');

  // A pending op with a change makes redo a no-op rather than applying on top.
  history.undo(); history.undo();
  assert.equal(history.redoStack.length, 2);
  history.begin();
  items[3].x = 800;
  assert.equal(history.redo(), null, 'redo with an open changed op finalises it and does nothing');
  assert.equal(history.redoStack.length, 0);

  // Entry-count limit and byte budget.
  for (let i = 0; i < 10; i++) { history.begin(); items[0].x += 1; history.finalize(); }
  assert.equal(history.undoStack.length, 4, 'the count limit holds');
  const tiny = createBoardHistory({ snapshot: () => snapshotBoard(items, boardProps), byteBudget: () => 1, minEntries: 2 });
  for (let i = 0; i < 6; i++) { tiny.begin(); items[0].x += 1; tiny.finalize(); }
  assert.equal(tiny.undoStack.length, 2, 'the byte budget trims down to the minimum entries');
  assert.ok(tiny.bytes() > 1, 'bytes are reported even over budget');

  // Extras survive an empty delta and are released with the entry.
  const marker = { bitmap: { imgId: 'img1', before: 'ref' } };
  history.begin(marker);
  const withExtra = history.finalize();
  assert.ok(withExtra && withExtra.delta === null && withExtra.bitmap.imgId === 'img1', 'an extra-only entry is kept');
  history.clear();
  assert.ok(released.includes(withExtra), 'clear releases every entry');
  assert.equal(history.undoStack.length + history.redoStack.length, 0);
  assert.throws(() => createBoardHistory({}), TypeError);
}

console.log('board history tests passed');
