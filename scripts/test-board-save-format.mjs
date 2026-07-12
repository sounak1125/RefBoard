import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { boardHeaderPrefix, boardImageParts } = require('./board-save-format.js');

const core = {
  app: 'refboard', version: 3,
  view: { tx: 1, ty: 2, s: 0.5 },
  boardGray: false, snapEnabled: true, gridAppearance: 'dots',
  items: [{ id: 'item-1', kind: 'image', imgId: 'image-1', name: 'quoted " name' }],
};
const bytesA = Buffer.from([0, 1, 2, 250, 255]);
const bytesB = new Uint8Array([9, 8, 7]);
const a = boardImageParts({ id: 'image-1', type: 'image/png', name: 'A "quoted".png' }, bytesA);
const b = boardImageParts({ id: 'image-2', type: 'not-safe', name: '雪.jpg' }, bytesB);
const json = boardHeaderPrefix(core, 'preview-base64')
  + a.prefix + a.base64 + a.suffix
  + ',' + b.prefix + b.base64 + b.suffix
  + ']}';
const parsed = JSON.parse(json);

assert.equal(parsed.preview, 'preview-base64');
assert.deepEqual(parsed.items, core.items);
assert.equal(parsed.images.length, 2);
assert.equal(parsed.images[0].data, `data:image/png;base64,${bytesA.toString('base64')}`);
assert.equal(parsed.images[1].type, 'application/octet-stream');
assert.equal(parsed.images[1].data, `data:application/octet-stream;base64,${Buffer.from(bytesB).toString('base64')}`);
assert.throws(() => boardImageParts({}, 'invalid'), /Invalid streamed board image data/);

console.log('board-save-format: streamed JSON round-trip passed');
