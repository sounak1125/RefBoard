import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  const brace = html.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(`${name} should have a complete body`);
}

const controlIds = ['sAlignH', 'sAlignV', 'sNormScale', 'sNormWidth', 'sNormHeight'];
for (const id of controlIds) {
  const match = html.match(new RegExp(`<button[^>]*id=["']${id}["'][\\s\\S]*?<\\/button>`));
  assert.ok(match, `${id} should remain in the selection bar`);
  assert.match(match[0], /<svg\b/, `${id} should use an inline theme-aware SVG`);
  assert.doesNotMatch(match[0], /tb-icon-img|<img\b/, `${id} should not use the retired bitmap icon style`);
}

assert.match(html, /function normalizeImagesByWidth\(\) \{ normalizeImagesBy\(['"]width['"]\); \}/);
assert.match(html, /function normalizeImagesByHeight\(\) \{ normalizeImagesBy\(['"]height['"]\); \}/);
assert.match(html, /\$\(['"]#sNormWidth['"]\)\.addEventListener\(['"]click['"], normalizeImagesByWidth\)/);
assert.match(html, /\$\(['"]#sNormHeight['"]\)\.addEventListener\(['"]click['"], normalizeImagesByHeight\)/);
assert.match(html, /\{ l: ['"]Normalize['"], sub: ['"]normalize['"] \}/, 'context menu should expose the Normalize submenu');
assert.match(html, /\{ l: ['"]Normalize scale['"], f: normalizeImagesByScale \}/);
assert.match(html, /\{ l: ['"]Normalize width['"], f: normalizeImagesByWidth \}/);
assert.match(html, /\{ l: ['"]Normalize height['"], f: normalizeImagesByHeight \}/);

const calls = { undo: 0, sync: 0, save: 0, invalidate: 0, toasts: [] };
let selected = [];
const context = {
  selectedImages: () => selected,
  pushUndo: () => calls.undo++,
  resizeImagePreserveCenter: (item, width, height) => {
    const cx = item.x + item.w / 2;
    const cy = item.y + item.h / 2;
    item.w = width;
    item.h = height;
    item.x = cx - width / 2;
    item.y = cy - height / 2;
  },
  syncGroupFramesForItems: () => calls.sync++,
  scheduleSave: () => calls.save++,
  invalidate: () => calls.invalidate++,
  toast: message => calls.toasts.push(message),
};
vm.runInNewContext(`${extractFunction('normalizeImagesBy')}; this.normalizeImagesBy = normalizeImagesBy;`, context);

function reset(items) {
  selected = structuredClone(items);
  calls.undo = calls.sync = calls.save = calls.invalidate = 0;
  calls.toasts.length = 0;
  return selected;
}

function center(item) {
  return [item.x + item.w / 2, item.y + item.h / 2];
}

let items = reset([
  { x: 10, y: 20, w: 100, h: 50 },
  { x: 300, y: 80, w: 200, h: 50 },
]);
const widthCenters = items.map(center);
context.normalizeImagesBy('width');
assert.deepEqual(items.map(i => [i.w, i.h]), [[100, 50], [100, 25]], 'width normalization should preserve aspect ratios');
assert.deepEqual(items.map(center), widthCenters, 'width normalization should preserve centers');

items = reset([
  { x: 0, y: 0, w: 100, h: 50 },
  { x: 220, y: 60, w: 200, h: 100 },
]);
const heightCenters = items.map(center);
context.normalizeImagesBy('height');
assert.deepEqual(items.map(i => [i.w, i.h]), [[100, 50], [100, 50]], 'height normalization should preserve aspect ratios');
assert.deepEqual(items.map(center), heightCenters, 'height normalization should preserve centers');

items = reset([
  { x: 0, y: 0, w: 100, h: 50 },
  { x: 200, y: 0, w: 80, h: 160 },
]);
context.normalizeImagesBy('scale');
assert.deepEqual(items.map(i => [i.w, i.h]), [[100, 50], [50, 100]], 'scale normalization should match the smallest maximum side');
assert.deepEqual([calls.undo, calls.sync, calls.save, calls.invalidate], [1, 1, 1, 1], 'normalization should remain one undoable saved operation');

reset([{ x: 0, y: 0, w: 100, h: 50 }]);
context.normalizeImagesBy('width');
assert.equal(calls.undo, 0, 'a single image should not create undo history');
assert.deepEqual(calls.toasts, ['Select 2+ images']);

console.log('selection tool contract tests passed');
