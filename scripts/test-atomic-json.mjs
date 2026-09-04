import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { writeJsonAtomic } = require('./atomic-json.js');

const dir = await mkdtemp(path.join(os.tmpdir(), 'refboard-atomic-json-'));
try {
  const target = path.join(dir, 'nested', 'recent-works.json');

  // Creates the directory and the file.
  const first = await writeJsonAtomic(target, [{ id: 'a', pinned: true }]);
  assert.equal(first.path, path.resolve(target));
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), [{ id: 'a', pinned: true }], 'the document round-trips');
  assert.deepEqual((await readdir(path.dirname(target))).filter(n => n.includes('.tmp-')), [], 'no temp file is left behind');

  // Replaces an existing file in place, including on Windows.
  await writeJsonAtomic(target, { replaced: true });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { replaced: true }, 'an existing document is replaced');
  assert.deepEqual((await readdir(path.dirname(target))).filter(n => n.includes('.tmp-')), [], 'still no temp file after a replace');

  // A failed write leaves the previous document intact and no temp file.
  const cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(writeJsonAtomic(target, cyclic), /circular|Converting circular structure/i, 'an unserialisable value rejects');
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { replaced: true }, 'the previous document survives a failed write');
  assert.deepEqual((await readdir(path.dirname(target))).filter(n => n.includes('.tmp-')), [], 'a failed write leaves no temp file');

  // A target that is a directory cannot be renamed over; the temp file is cleaned up.
  const blocked = path.join(dir, 'blocked.json');
  await mkdir(blocked);
  await assert.rejects(writeJsonAtomic(blocked, { x: 1 }), 'renaming over a directory fails');
  assert.deepEqual((await readdir(dir)).filter(n => n.includes('.tmp-')), [], 'the temp file is removed when the rename fails');

  // Indentation matches what the stores wrote before, so diffs stay readable.
  await writeJsonAtomic(target, { a: 1 });
  assert.equal(await readFile(target, 'utf8'), JSON.stringify({ a: 1 }, null, 2), 'two-space indentation is preserved');

  console.log('atomic json tests passed');
} finally {
  await rm(dir, { recursive: true, force: true });
}
