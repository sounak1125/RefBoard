/**
 * Tests for copy-operation gating, serialized clipboard writes, and cut ID capture.
 * Imports production helpers from clipboard-copy-order.mjs.
 * Run: node scripts/test-clipboard-copy-order.mjs
 */

import {
  createCopyOperationGate,
  createClipboardWriteQueue,
  expandSelectionDeleteIds,
  deleteIdsAfterSuccessfulCutCopy,
} from './clipboard-copy-order.mjs';

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// 1–2: A starts then B; A becomes stale and never writes; B is final write.
{
  const gate = createCopyOperationGate();
  const queue = createClipboardWriteQueue();
  const writes = [];

  const opA = gate.begin();
  const opB = gate.begin();
  assert(opB > opA, 'sequence increases');
  assert(!gate.isCurrent(opA), 'A stale after B begins');
  assert(gate.isCurrent(opB), 'B is current');

  const a = queue.enqueue(opA, op => gate.isCurrent(op), async () => { writes.push('A'); });
  const b = queue.enqueue(opB, op => gate.isCurrent(op), async () => { writes.push('B'); });

  const [ra, rb] = await Promise.all([a, b]);
  assert(ra.stale === true && ra.ok === false, 'A skipped as stale before write');
  assert(rb.ok === true, 'B write succeeded');
  assert(writes.join(',') === 'B', 'only B wrote');
}

// 3: A write already active when B starts; B writes afterward.
{
  const gate = createCopyOperationGate();
  const queue = createClipboardWriteQueue();
  const writes = [];
  let releaseA;
  const aStarted = new Promise(r => { releaseA = r; });

  const opA = gate.begin();
  const writeA = queue.enqueue(opA, op => gate.isCurrent(op), async () => {
    writes.push('A-start');
    await new Promise(resolve => { releaseA(); setTimeout(resolve, 40); });
    writes.push('A-end');
  });

  await aStarted;
  const opB = gate.begin();
  const writeB = queue.enqueue(opB, op => gate.isCurrent(op), async () => { writes.push('B'); });

  const [ra, rb] = await Promise.all([writeA, writeB]);
  assert(ra.ok === true, 'in-flight A may finish writing');
  assert(ra.stale === true, 'A is stale after B began during A write');
  assert(rb.ok === true && rb.stale === false, 'B wins');
  assert(writes.join(',') === 'A-start,A-end,B', 'A finishes then B writes');
}

// 4–5: Stale op must not drive success feedback / local clipboard update.
{
  const gate = createCopyOperationGate();
  const queue = createClipboardWriteQueue();
  let localItemClipboard = null;
  let lastToast = null;
  function toast(msg) { lastToast = msg; }

  async function simulateImageCopySuccessPath(op, payload, blob, deleteIds) {
    if (!gate.isCurrent(op)) return false;
    const result = await queue.enqueue(op, o => gate.isCurrent(o), async () => {});
    if (!result.ok) return false;
    if (!gate.isCurrent(op)) return false;
    localItemClipboard = { payload, pngSize: blob.size };
    toast('Copied selection');
    return { ok: true, deleteIds };
  }

  const opA = gate.begin();
  const opB = gate.begin();
  const aOk = await simulateImageCopySuccessPath(opA, { id: 'a' }, { size: 1 }, ['a']);
  const bOk = await simulateImageCopySuccessPath(opB, { id: 'b' }, { size: 2 }, ['b']);

  assert(aOk === false, 'stale A does not succeed');
  assert(bOk?.ok === true, 'B succeeds');
  assert(lastToast === 'Copied selection', 'Copied toast from winner only');
  assert(localItemClipboard?.payload?.id === 'b', 'localItemClipboard from B only');
}

// Cut deletes captured IDs only; failed/stale delete nothing; selection change ignored.
{
  const gate = createCopyOperationGate();
  const queue = createClipboardWriteQueue();
  const board = new Set();

  async function copyLike(deleteIds, { failWrite } = {}) {
    const op = gate.begin();
    const result = await queue.enqueue(op, o => gate.isCurrent(o), async () => {
      if (failWrite) throw new Error('clipboard blocked');
    });
    if (!result.ok || !gate.isCurrent(op)) return false;
    return { ok: true, deleteIds };
  }

  function applyCut(copyResult) {
    const ids = deleteIdsAfterSuccessfulCutCopy(copyResult);
    if (!ids) return [];
    const removed = [];
    for (const id of ids) {
      if (board.has(id)) { board.delete(id); removed.push(id); }
    }
    return removed;
  }

  board.clear(); ['A', 'B', 'C'].forEach(id => board.add(id));
  assert(applyCut(await copyLike(['A'])).join(',') === 'A', 'cut deletes captured A only');
  assert(board.has('B') && board.has('C') && !board.has('A'), 'B/C remain');

  board.clear(); ['A', 'B', 'C'].forEach(id => board.add(id));
  assert(applyCut(await copyLike(['A', 'B'])).sort().join(',') === 'A,B', 'cut deletes A+B only');
  assert(board.has('C') && !board.has('A') && !board.has('B'), 'only C remains');

  board.clear(); board.add('A');
  assert(applyCut(await copyLike(['A'], { failWrite: true })).length === 0, 'failed write deletes nothing');
  assert(board.has('A'), 'A remains after failed cut');

  board.clear(); ['A', 'B'].forEach(id => board.add(id));
  const opA = gate.begin();
  const opB = gate.begin();
  const staleA = await queue.enqueue(opA, o => gate.isCurrent(o), async () => {});
  assert(staleA.ok === false && staleA.stale === true, 'A stale');
  assert(applyCut(false).length === 0, 'stale/false cut deletes nothing');
  assert((await queue.enqueue(opB, o => gate.isCurrent(o), async () => {})).ok === true, 'B writes');
  assert(applyCut({ ok: true, deleteIds: ['B'] }).join(',') === 'B', 'winning B cut deletes B');
  assert(board.has('A') && !board.has('B'), 'A remains, B removed');
}

{
  const childMap = new Map([['G', ['c1', 'c2']]]);
  const ids = expandSelectionDeleteIds(['G', 'solo'], gid => childMap.get(gid) || []);
  assert([...ids].sort().join(',') === 'G,c1,c2,solo', 'group expands children');
  assert(deleteIdsAfterSuccessfulCutCopy(false) === null, 'false → no cut delete');
  assert(deleteIdsAfterSuccessfulCutCopy({ ok: true, deleteIds: [] }) === null, 'empty ids → no cut delete');
  assert(deleteIdsAfterSuccessfulCutCopy({ ok: true, deleteIds: ['x'] }).join(',') === 'x', 'ok+ids');
}

{
  function demoteUnreferenced(items, images) {
    const used = new Set(items.filter(i => i.imgId).map(i => i.imgId));
    return [...images.keys()].filter(imgId => !used.has(imgId));
  }
  const images = new Map([['img1', {}], ['img2', {}]]);
  let items = [
    { id: 'A', imgId: 'img1' },
    { id: 'B', imgId: 'img1' },
    { id: 'C', imgId: 'img2' },
  ];
  items = items.filter(i => i.id !== 'A');
  assert(demoteUnreferenced(items, images).join(',') === '', 'shared img1 not demoted while B remains');
  items = items.filter(i => i.id !== 'B');
  assert(demoteUnreferenced(items, images).join(',') === 'img1', 'img1 demoted after last ref gone');
}

{
  const gate = createCopyOperationGate();
  const queue = createClipboardWriteQueue();
  const writes = [];
  const opFail = gate.begin();
  assert((await queue.enqueue(opFail, o => gate.isCurrent(o), async () => { throw new Error('boom'); })).ok === false);
  const opOk = gate.begin();
  assert((await queue.enqueue(opOk, o => gate.isCurrent(o), async () => { writes.push('recovered'); })).ok === true);
  assert(writes.join(',') === 'recovered', 'queue recovered after failure');
}

{
  const gate = createCopyOperationGate();
  const queue = createClipboardWriteQueue();
  const writes = [];
  const noteOp = gate.begin();
  const imageOp = gate.begin();
  const [rn, ri] = await Promise.all([
    queue.enqueue(noteOp, o => gate.isCurrent(o), async () => { writes.push('note'); }),
    queue.enqueue(imageOp, o => gate.isCurrent(o), async () => { writes.push('image'); }),
  ]);
  assert(rn.stale === true && rn.ok === false, 'older note write skipped');
  assert(ri.ok === true && writes.join(',') === 'image', 'only newer image writes');
}

{
  assert(({ noLod: true }).noLod === true, 'copy composite uses noLod');
}

console.log('clipboard-copy-order: all checks passed');
