import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat, writeFile, open } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const sidecar = require('./board-sidecar.js');
const { readBoardPreview } = require('./board-open-stream.js');
const { extractPreviewBase64 } = require('./file-icon-composite.js');

const dir = await mkdtemp(path.join(os.tmpdir(), 'refboard-sidecar-'));
try {
  const indexPath = path.join(dir, 'board.refboard');
  const storePath = sidecar.sidecarStorePath(indexPath);
  assert.equal(storePath, `${path.resolve(indexPath)}.images`, 'the store sits beside the index with a derived name');

  /* --- append and read back --- */
  const store = await sidecar.openSidecarStore(storePath, { create: true });
  assert.equal(store.size, sidecar.STORE_MAGIC.length, 'a fresh store is just its magic');
  const bytesA = Buffer.from([0, 1, 2, 250, 255, 9, 9, 9]);
  const bytesB = Buffer.alloc(300_000, 7);
  const a = await sidecar.appendSidecarImage(store, { id: 'a', type: 'image/png' }, bytesA);
  const b = await sidecar.appendSidecarImage(store, { id: 'b', type: 'image/jpeg' }, new Uint8Array(bytesB));
  assert.equal(a.length, bytesA.length);
  assert.ok(b.offset > a.offset + a.length, 'records are laid out in order');
  assert.ok((await sidecar.readSidecarImage(store.handle, a, store.size)).equals(bytesA), 'first image reads back');
  assert.ok((await sidecar.readSidecarImage(store.handle, b, store.size)).equals(bytesB), 'second image reads back');
  await assert.rejects(sidecar.readSidecarImage(store.handle, { offset: b.offset, length: b.length + 1 }, store.size), /beyond the store/, 'a range past the end is refused');
  await assert.rejects(sidecar.readSidecarImage(store.handle, { offset: 2, length: 4 }, store.size), /Invalid board image range/, 'a range inside the magic is refused');
  await store.handle.close();

  /* --- index: format head, preview position, legacy readers --- */
  const preview = Buffer.from('a jpeg preview, pretend').toString('base64');
  const core = {
    app: 'refboard', version: 3, view: { tx: 1, ty: 2, s: 0.5 }, boardGray: false,
    gridAppearance: 'dots', tagColors: {}, items: [{ id: 'i1', kind: 'image', imgId: 'a' }, { id: 'i2', kind: 'note', text: ',"images":[' }],
  };
  const images = [
    { id: 'a', type: 'image/png', name: 'A "quoted".png', w: 10, h: 20, size: bytesA.length, ...a },
    { id: 'b', type: 'image/jpeg', name: '雪.jpg', w: 30, h: 40, size: bytesB.length, ...b },
  ];
  await sidecar.writeSidecarIndex(indexPath, core, preview, images);
  const text = await readFile(indexPath, 'utf8');
  assert.ok(text.startsWith('{"format":"refboard-sidecar-1","preview":"'), 'format first, preview second');
  assert.ok(text.endsWith(']}'), 'images is the last key');
  const parsed = JSON.parse(text);
  assert.equal(parsed.version, 4, 'the index is version 4 whatever the core said');
  assert.equal(parsed.app, 'refboard');
  assert.deepEqual(parsed.items, core.items, 'items round-trip');
  assert.deepEqual(parsed.images.map(i => i.id), ['a', 'b']);
  assert.equal(parsed.images[0].offset, a.offset);
  assert.equal(await readBoardPreview(indexPath), preview, 'the legacy header reader still finds the preview');
  assert.equal(extractPreviewBase64(indexPath), preview, 'the Explorer thumbnail extractor still finds the preview');
  assert.ok(!existsSync(`${indexPath}.saving-${process.pid}`), 'no temp index left');

  const read = await sidecar.readSidecarIndex(indexPath);
  assert.equal(read.format, 'refboard-sidecar-1');
  assert.equal(read.images[1].name, '雪.jpg');
  assert.equal(read.images[1].length, bytesB.length);

  // A legacy embedded board is not an index.
  const legacyPath = path.join(dir, 'legacy.refboard');
  await writeFile(legacyPath, '{"preview":"x","app":"refboard","version":3,"items":[],"images":[{"id":"a","data":"data:image/png;base64,AAAA"}]}');
  assert.equal(await sidecar.readSidecarIndex(legacyPath), null, 'a legacy board reads as null, not an error');
  assert.equal(sidecar.isSidecarIndexHead(Buffer.from('{"preview":"...')), false);

  // A second write keeps the previous index as .bak and no temp files.
  await sidecar.writeSidecarIndex(indexPath, core, null, images);
  assert.ok(existsSync(`${indexPath}.bak`), 'rewriting the index keeps the previous one as .bak');
  assert.equal(JSON.parse(await readFile(indexPath, 'utf8')).preview, undefined, 'a null preview omits the key');

  /* --- reopening appends after the existing records --- */
  const again = await sidecar.openSidecarStore(storePath);
  assert.equal(again.size, b.offset + b.length, 'reopen reports the real size');
  const c = await sidecar.appendSidecarImage(again, { id: 'c', type: 'image/webp' }, Buffer.from('third'));
  assert.equal(c.offset, again.size - 5);
  await again.handle.close();

  /* --- a torn tail is skipped over, not read --- */
  const torn = await open(storePath, 'r+');
  await torn.write(Buffer.from('RBIM\xff\xff\xff\xff garbage from a crash'), 0, 32, c.offset + c.length);
  await torn.close();
  const afterTorn = await sidecar.openSidecarStore(storePath);
  const d = await sidecar.appendSidecarImage(afterTorn, { id: 'd', type: 'image/png' }, Buffer.from('fourth'));
  assert.ok(d.offset > c.offset + c.length + 32, 'the next append lands after the torn bytes');
  assert.ok((await sidecar.readSidecarImage(afterTorn.handle, c, afterTorn.size)).equals(Buffer.from('third')), 'records before the tear still read');
  assert.ok((await sidecar.readSidecarImage(afterTorn.handle, d, afterTorn.size)).equals(Buffer.from('fourth')), 'the record after the tear reads');
  const scanned = await sidecar.scanSidecarStore(storePath);
  assert.deepEqual(scanned.records.map(r => r.id), ['a', 'b', 'c'], 'a scan recovers every record before the tear');
  assert.equal(scanned.torn, true, 'and reports the tear');
  await afterTorn.handle.close();

  /* --- garbage accounting and compaction --- */
  const size = (await stat(storePath)).size;
  const live = [images[1], { ...images[0], id: 'd', ...d, size: 6 }];
  const garbage = sidecar.sidecarGarbageBytes(size, live);
  assert.ok(garbage >= bytesA.length + 5 + 32, `dropped records and the tear count as garbage (${garbage})`);
  assert.equal(sidecar.shouldCompactSidecar(size, garbage), false, 'a small store never compacts at the default threshold');
  assert.equal(sidecar.shouldCompactSidecar(size, garbage, { minBytes: 1 }), garbage >= size * 0.25, 'the ratio gate applies once the byte gate passes');
  assert.equal(sidecar.shouldCompactSidecar(1000, 400, { minBytes: 1, minRatio: 0.25 }), true);
  assert.equal(sidecar.shouldCompactSidecar(1000, 100, { minBytes: 1, minRatio: 0.25 }), false);

  const compacted = await sidecar.compactSidecarStore(storePath, live);
  assert.deepEqual(compacted.images.map(i => i.id), ['b', 'd']);
  assert.ok(compacted.size < size, 'compaction shrinks the store');
  assert.equal((await stat(storePath)).size, compacted.size, 'the store on disk is the compacted one');
  const fresh = await sidecar.openSidecarStore(storePath);
  assert.ok((await sidecar.readSidecarImage(fresh.handle, compacted.images[0], fresh.size)).equals(bytesB), 'kept bytes survive compaction at new offsets');
  assert.ok((await sidecar.readSidecarImage(fresh.handle, compacted.images[1], fresh.size)).equals(Buffer.from('fourth')));
  await fresh.handle.close();
  const rescanned = await sidecar.scanSidecarStore(storePath);
  assert.deepEqual(rescanned.records.map(r => r.id), ['b', 'd']);
  assert.equal(rescanned.torn, false, 'a compacted store has no tear');
  assert.equal((await import('node:fs')).readdirSync(dir).filter(n => n.includes('.compact-')).length, 0, 'no compaction temp file left');

  /* --- truncate starts over --- */
  const wiped = await sidecar.openSidecarStore(storePath, { create: true, truncate: true });
  assert.equal(wiped.size, sidecar.STORE_MAGIC.length);
  await wiped.handle.close();
  await assert.rejects(sidecar.openSidecarStore(path.join(dir, 'missing.images')), /ENOENT/, 'opening a missing store without create fails');
  await writeFile(path.join(dir, 'foreign.images'), 'this is not a store, it is text');
  await assert.rejects(sidecar.openSidecarStore(path.join(dir, 'foreign.images')), /Not a RefBoard image store/);

  console.log('board sidecar tests passed');
} finally {
  await rm(dir, { recursive: true, force: true });
}
