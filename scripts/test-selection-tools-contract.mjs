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

function rotatedBounds(item) {
  const angle = ((item.rot || 0) * Math.PI) / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const cx = item.x + item.w / 2, cy = item.y + item.h / 2;
  const points = [[0, 0], [item.w, 0], [item.w, item.h], [0, item.h]].map(([x, y]) => {
    const dx = x - item.w / 2, dy = y - item.h / 2;
    return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
  });
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

const alignCalls = { undo: 0, sync: 0, save: 0, invalidate: 0, workspace: 0 };
const alignState = { items: [], sel: new Set(), anchorId: null };
const alignContext = {
  state: alignState,
  selectedItems: () => alignState.items.filter(item => alignState.sel.has(item.id)),
  byId: id => alignState.items.find(item => item.id === id),
  boundsOf: rotatedBounds,
  isArrowItem: item => item.kind === 'arrow',
  isGroupItem: item => item.kind === 'group',
  childrenOfGroup: id => alignState.items.filter(item => item.groupId === id),
  pushUndo: () => alignCalls.undo++,
  syncGroupFramesForItems: () => alignCalls.sync++,
  invalidateWorkspaceBBox: () => alignCalls.workspace++,
  scheduleSave: () => alignCalls.save++,
  invalidate: () => alignCalls.invalidate++,
};
vm.runInNewContext(`
  const ALIGN_GAP = 5;
  ${extractFunction('translateAlignedItem')}
  ${extractFunction('alignSelectionHorizontal')}
  ${extractFunction('alignSelectionVertical')}
  this.alignSelectionHorizontal = alignSelectionHorizontal;
  this.alignSelectionVertical = alignSelectionVertical;
`, alignContext);

function resetAlignment(nextItems, anchorId = nextItems[0]?.id) {
  alignState.items = structuredClone(nextItems);
  alignState.sel = new Set(alignState.items.map(item => item.id));
  alignState.anchorId = anchorId;
  for (const key of Object.keys(alignCalls)) alignCalls[key] = 0;
  return alignState.items;
}

function closeTo(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `${message}: expected ${expected}, received ${actual}`);
}

let aligned = resetAlignment([
  { id: 'anchor', x: 10, y: 20, w: 120, h: 60, rot: 45 },
  { id: 'wide', x: 500, y: 40, w: 200, h: 70, rot: 315 },
  { id: 'tall', x: 300, y: 80, w: 80, h: 160, rot: 45 },
]);
const horizontalAnchorBefore = rotatedBounds(aligned[0]);
alignContext.alignSelectionHorizontal();
const horizontalBounds = aligned.map(rotatedBounds);
closeTo(horizontalBounds[0].x, horizontalAnchorBefore.x, 'horizontal alignment should not move the anchor x');
closeTo(horizontalBounds[0].y, horizontalAnchorBefore.y, 'horizontal alignment should not move the anchor y');
for (const bounds of horizontalBounds) closeTo(bounds.y, horizontalBounds[0].y, 'horizontal alignment should align visible top edges');
closeTo(horizontalBounds[2].x - (horizontalBounds[0].x + horizontalBounds[0].w), 5, 'first horizontal visual gap');
closeTo(horizontalBounds[1].x - (horizontalBounds[2].x + horizontalBounds[2].w), 5, 'second horizontal visual gap');

aligned = resetAlignment([
  { id: 'anchor', x: 10, y: 20, w: 120, h: 60, rot: 45 },
  { id: 'low', x: 80, y: 500, w: 200, h: 70, rot: 315 },
  { id: 'middle', x: 300, y: 250, w: 80, h: 160, rot: 45 },
]);
const verticalAnchorBefore = rotatedBounds(aligned[0]);
alignContext.alignSelectionVertical();
const verticalBounds = aligned.map(rotatedBounds);
closeTo(verticalBounds[0].x, verticalAnchorBefore.x, 'vertical alignment should not move the anchor x');
closeTo(verticalBounds[0].y, verticalAnchorBefore.y, 'vertical alignment should not move the anchor y');
for (const bounds of verticalBounds) closeTo(bounds.x, verticalBounds[0].x, 'vertical alignment should align visible left edges');
closeTo(verticalBounds[2].y - (verticalBounds[0].y + verticalBounds[0].h), 5, 'first vertical visual gap');
closeTo(verticalBounds[1].y - (verticalBounds[2].y + verticalBounds[2].h), 5, 'second vertical visual gap');
assert.deepEqual(Object.values(alignCalls), [1, 1, 1, 1, 1], 'alignment should remain one undoable saved operation');

const cursorContext = {};
vm.runInNewContext(`
  ${extractFunction('resizeCursorForAngle')}
  ${extractFunction('resizeCursorForHandle')}
  this.resizeCursorForHandle = resizeCursorForHandle;
`, cursorContext);
assert.equal(cursorContext.resizeCursorForHandle({ edge: 'bottom' }, 0), 'ns-resize');
assert.equal(cursorContext.resizeCursorForHandle({ edge: 'bottom' }, 45), 'nesw-resize', 'a rotated bottom edge should show a matching diagonal cursor');
assert.equal(cursorContext.resizeCursorForHandle({ edge: 'right' }, 45), 'nwse-resize', 'a rotated side edge should show a matching diagonal cursor');
assert.equal(cursorContext.resizeCursorForHandle({ corner: 'nw' }, 45), 'ns-resize', 'rotated corner cursors should follow the handle direction');
assert.match(html, /resizeCursorForHandle\(h, h\.group \? 0 : \(h\.it\?\.rot \|\| 0\)\)/, 'the axis-aligned multi-selection box should keep its unrotated cursors');

console.log('selection tool contract tests passed');
