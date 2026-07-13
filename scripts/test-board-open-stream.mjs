import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { boardHeaderPrefix, boardImageParts } = require('./board-save-format.js');
const { scanBoardFile, readBoardImageBytes } = require('./board-open-stream.js');

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refboard-stream-test-'));
const file = path.join(dir, 'sample.refboard');
try {
  const core = { app: 'refboard', version: 3, items: [{ id: 'i1', imgId: 'a' }], note: ',"images":[' };
  const a = Buffer.from('first image bytes');
  const b = Buffer.from([0, 1, 2, 3, 250, 251, 252]);
  const pa = boardImageParts({ id: 'a', type: 'image/png', name: 'A', w: 10, h: 20 }, a);
  const pb = boardImageParts({ id: 'b', type: 'image/jpeg', name: 'B', w: 30, h: 40 }, b);
  const json = boardHeaderPrefix(core, null)
    + pa.prefix + pa.base64 + pa.suffix + ','
    + pb.prefix + pb.base64 + pb.suffix + ']}';
  await fs.writeFile(file, json);

  const scanned = await scanBoardFile(file);
  assert(scanned.core.app === 'refboard', 'core parsed');
  assert(scanned.images.length === 2, 'two images indexed');
  assert(scanned.images[0].w === 10 && scanned.images[1].h === 40, 'dimensions retained');
  assert((await readBoardImageBytes(file, scanned.images[0])).equals(a), 'first image range decodes');
  assert((await readBoardImageBytes(file, scanned.images[1])).equals(b), 'second image range decodes');
  console.log('board open stream tests passed');
} finally {
  await fs.rm(dir, { recursive: true, force: true });
}
