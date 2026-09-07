import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const c = require('./board-container.js');
const sidecar = require('./board-sidecar.js');
const { extractPreviewBase64 } = require('./file-icon-composite.js');

const dir = await mkdtemp(path.join(os.tmpdir(), 'refboard-container-'));
try {
  const file = path.join(dir, 'board.refboard');
  const core = { view: { tx: 1, ty: 2, s: 0.5 }, boardGray: false, gridAppearance: 'dots', tagColors: {}, items: [{ id: 'i1', kind: 'image', imgId: 'a' }, { id: 'n1', kind: 'note', text: '"images":[ RFBDIDX1' }] };
  const preview = Buffer.from('a jpeg preview, pretend, long enough to matter '.repeat(40)).toString('base64');

  /* --- a fresh file: head region, then records, then index and trailer --- */
  const box = await c.openContainer(file, { create: true });
  assert.equal(box.size, c.HEAD_REGION_BYTES, 'a fresh container is exactly the head region');
  assert.equal(box.index, null, 'and has no index yet');
  const bytesA = Buffer.from([0, 1, 2, 250, 255, 9, 9, 9]);
  const bytesB = Buffer.alloc(300_000, 7);
  const a = await c.appendContainerImage(box, { id: 'a', type: 'image/png' }, bytesA);
  const b = await c.appendContainerImage(box, { id: 'b', type: 'image/jpeg' }, new Uint8Array(bytesB));
  assert.ok(a.offset > c.HEAD_REGION_BYTES && b.offset > a.offset + a.length, 'records follow the head region in order');
  const images = [
    { id: 'a', type: 'image/png', name: 'A "quoted".png', w: 10, h: 20, size: bytesA.length, ...a },
    { id: 'b', type: 'image/jpeg', name: '雪.jpg', w: 30, h: 40, size: bytesB.length, ...b },
  ];
  const written = await c.writeContainerIndex(box, core, preview, images);
  assert.equal(written.size, box.size);
  assert.equal((await stat(file)).size, box.size, 'the file ends at the trailer');
  await box.handle.close();

  /* --- the front of the file identifies itself and carries the preview --- */
  const head = await readFile(file);
  assert.ok(c.isContainerHead(head), 'the magic is at offset 0');
  assert.equal(extractPreviewBase64(file), preview, 'the Explorer extractor finds the preview in the first 512 KB');
  assert.equal(await c.readContainerPreview(file), preview, 'the preview reader finds it in the head stub');
  assert.equal(sidecar.isSidecarIndexHead(head), false, 'a container is not mistaken for a sidecar index');
  assert.ok(head.subarray(c.HEAD_REGION_BYTES - 64, c.HEAD_REGION_BYTES).toString('utf8').trim() === '', 'the head stub is space-padded to the region');

  /* --- reopen: the index comes from the tail --- */
  const again = await c.openContainer(file);
  assert.equal(again.index.format, c.INDEX_FORMAT);
  assert.equal(again.index.version, 5);
  assert.deepEqual(again.index.items, core.items, 'items round-trip');
  assert.deepEqual(again.index.images.map(i => i.id), ['a', 'b']);
  assert.equal(again.index.preview, undefined, 'the tail index leaves the preview to the head stub when it fits there');
  assert.equal(again.recovered, false);
  assert.ok((await c.readContainerImage(again.handle, again.index.images[0], again.size)).equals(bytesA), 'first image reads back');
  assert.ok((await c.readContainerImage(again.handle, again.index.images[1], again.size)).equals(bytesB), 'second image reads back');
  const sizeAfterFirst = again.size;

  /* --- a second save appends only the new record and a new index --- */
  const cc = await c.appendContainerImage(again, { id: 'c', type: 'image/webp' }, Buffer.from('third'));
  const images2 = [...again.index.images, { id: 'c', type: 'image/webp', name: 'c.webp', w: 1, h: 1, size: 5, ...cc }];
  await c.writeContainerIndex(again, { ...core, boardGray: true }, null, images2);
  await again.handle.close();
  const third = await c.openContainer(file, { write: false });
  assert.equal(third.index.boardGray, true, 'the newest index wins');
  assert.deepEqual(third.index.images.map(i => i.id), ['a', 'b', 'c']);
  assert.equal(third.index.preview, undefined, 'a null preview omits the key');
  assert.equal(await c.readContainerPreview(file), null, 'and the head stub no longer carries one');
  assert.ok(third.size > sizeAfterFirst, 'the file grew by the record and the index');
  await third.handle.close();

  /* --- a torn tail (crash mid-save) falls back to the previous index --- */
  const torn = await open(file, 'r+');
  const size = (await torn.stat()).size;
  await torn.write(Buffer.from('RBIM garbage from a crash and half an index {"format":"refboard-con'), 0, 66, size);
  await torn.close();
  const recovered = await c.openContainer(file, { write: false });
  assert.equal(recovered.recovered, true, 'the trailer at the end is invalid, so recovery ran');
  assert.deepEqual(recovered.index.images.map(i => i.id), ['a', 'b', 'c'], 'the previous index was found intact');
  assert.equal(recovered.index.boardGray, true);
  assert.ok((await c.readContainerImage(recovered.handle, recovered.index.images[2], recovered.size)).equals(Buffer.from('third')));
  await recovered.handle.close();
  // The next save appends after the torn bytes; the file stays readable.
  const after = await c.openContainer(file);
  await c.writeContainerIndex(after, core, preview, after.index.images);
  await after.handle.close();
  assert.equal((await c.openContainer(file, { write: false }).then(async o => { const r = o.recovered; await o.handle.close(); return r; })), false, 'a save after a tear leaves a valid trailer again');

  /* --- garbage accounting and compaction --- */
  const now = await c.openContainer(file, { write: false });
  const live = now.index.images.filter(i => i.id !== 'a');
  const garbage = c.containerGarbageBytes(now.size, live, now.indexLength);
  assert.ok(garbage > bytesA.length + 66, `dead record, dead indexes and the tear all count (${garbage})`);
  assert.equal(c.shouldCompactContainer(now.size, garbage), false, 'a small file never compacts at the default threshold');
  assert.equal(c.shouldCompactContainer(1000, 400, { minBytes: 1, minRatio: 0.25 }), true);
  assert.equal(c.shouldCompactContainer(1000, 100, { minBytes: 1, minRatio: 0.25 }), false);
  await now.handle.close();
  const rebuilt = await c.rebuildContainer(file, { sourcePath: file, core, preview, images: live });
  assert.deepEqual(rebuilt.images.map(i => i.id), ['b', 'c']);
  assert.equal((await stat(file)).size, rebuilt.size, 'the swapped-in file is the compacted one');
  assert.ok(rebuilt.size < now.size, 'compaction shrinks the file');
  const fresh = await c.openContainer(file, { write: false });
  assert.equal(c.containerGarbageBytes(fresh.size, fresh.index.images, fresh.indexLength), 0, 'a compacted file has no dead bytes');
  assert.ok((await c.readContainerImage(fresh.handle, fresh.index.images[0], fresh.size)).equals(bytesB), 'kept bytes survive at new offsets');
  assert.ok((await c.readContainerImage(fresh.handle, fresh.index.images[1], fresh.size)).equals(Buffer.from('third')));
  assert.equal(fresh.index.preview, undefined, 'a rebuilt file keeps the preview in the stub, not the index');
  await fresh.handle.close();
  assert.equal(extractPreviewBase64(file), preview, 'the rebuilt file carries the preview at the front');
  assert.equal(readdirSync(dir).filter(n => n.includes('.saving-')).length, 0, 'no temp file left');

  /* --- converting a sidecar pair: records come from the store --- */
  const pairIndex = path.join(dir, 'pair.refboard');
  const store = await sidecar.openSidecarStore(sidecar.sidecarStorePath(pairIndex), { create: true });
  const pa = await sidecar.appendSidecarImage(store, { id: 'p', type: 'image/png' }, Buffer.from('pair-bytes'));
  await store.handle.close();
  await sidecar.writeSidecarIndex(pairIndex, core, preview, [{ id: 'p', type: 'image/png', name: 'p.png', w: 1, h: 1, size: 10, ...pa }]);
  const converted = await c.rebuildContainer(pairIndex, { sourcePath: sidecar.sidecarStorePath(pairIndex), core, preview, images: [{ id: 'p', type: 'image/png', name: 'p.png', w: 1, h: 1, size: 10, ...pa }] });
  const pairBox = await c.openContainer(pairIndex, { write: false });
  assert.ok((await c.readContainerImage(pairBox.handle, converted.images[0], pairBox.size)).equals(Buffer.from('pair-bytes')), 'a sidecar store converts into the single file');
  await pairBox.handle.close();

  /* --- an oversized preview is left out of the stub, not truncated --- */
  const huge = 'A'.repeat(600 * 1024);
  const big = await c.openContainer(path.join(dir, 'huge.refboard'), { create: true });
  const h = await c.appendContainerImage(big, { id: 'h', type: 'image/png' }, Buffer.from('x'));
  await c.writeContainerIndex(big, core, huge, [{ id: 'h', type: 'image/png', name: '', w: 1, h: 1, size: 1, ...h }]);
  await big.handle.close();
  const reopened = await c.openContainer(path.join(dir, 'huge.refboard'), { write: false });
  assert.equal(reopened.index.preview, huge, 'the tail index keeps the whole preview');
  await reopened.handle.close();
  assert.equal(await c.readContainerPreview(path.join(dir, 'huge.refboard')), huge, 'the preview reader falls back to the tail when the stub has none');

  /* --- not a container --- */
  await writeFile(path.join(dir, 'legacy.refboard'), '{"preview":"x","app":"refboard","version":3,"items":[],"images":[]}');
  await assert.rejects(c.openContainer(path.join(dir, 'legacy.refboard'), { write: false }), /Not a RefBoard board file/);
  assert.equal(c.isContainerHead(Buffer.from('{"preview"')), false);
  await assert.rejects(c.openContainer(path.join(dir, 'missing.refboard'), { write: false }), /ENOENT/);

  console.log('board container tests passed');
} finally {
  await rm(dir, { recursive: true, force: true });
}
