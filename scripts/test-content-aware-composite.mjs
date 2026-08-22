import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function outwardFeatherAlpha');
const end = html.indexOf('function refreshFillPreview', start);
assert.ok(start >= 0 && end > start, 'composite helpers must be present');
const sandbox = {
  Uint8Array, Uint8ClampedArray, Float32Array, Math,
  clamp: (value, lo, hi) => Math.max(lo, Math.min(hi, value)),
};
vm.createContext(sandbox);
vm.runInContext(`${html.slice(start, end)}\nthis.outwardFeatherAlpha = outwardFeatherAlpha; this.composeFillCrop = composeFillCrop;`, sandbox);

const w = 15, h = 13, mask = new Uint8Array(w * h);
for (let y = 5; y <= 7; y++) for (let x = 6; x <= 8; x++) mask[y * w + x] = 1;
const source = new Uint8ClampedArray(w * h * 4);
const fill = new Uint8ClampedArray(w * h * 4);
for (let i = 0; i < w * h; i++) {
  source.set([i & 255, i * 3 & 255, i * 7 & 255, 173], i * 4);
  fill.set([230, 220, 210, 255], i * 4);
}
const session = {
  candidates: [{ pixels: fill }], candidateIndex: 0, sourcePixels: source, mask,
  bounds: { cropW: w, cropH: h }, feather: 2,
};
const composite = sandbox.composeFillCrop(session);

const hard = (6 * w + 7) * 4;
assert.deepEqual([...composite.subarray(hard, hard + 4)], [230, 220, 210, 255],
  'the hard mask must be fully replaced');
const exterior = (1 * w + 1) * 4;
assert.deepEqual([...composite.subarray(exterior, exterior + 4)], [...source.subarray(exterior, exterior + 4)],
  'pixels outside the outward band must remain bit-identical');
const justOutside = (6 * w + 5) * 4;
assert.notDeepEqual([...composite.subarray(justOutside, justOutside + 3)], [...source.subarray(justOutside, justOutside + 3)],
  'feathering must fall outward from the hard mask');
assert.equal(composite[justOutside + 3], source[justOutside + 3], 'outward feather must preserve exterior alpha');

session.feather = 0;
const hardOnly = sandbox.composeFillCrop(session);
for (let i = 0; i < mask.length; i++) if (!mask[i]) {
  assert.deepEqual([...hardOnly.subarray(i * 4, i * 4 + 4)], [...source.subarray(i * 4, i * 4 + 4)]);
}

console.log('content-aware outward composite tests passed');
