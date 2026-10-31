import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { rowAlignShifts } from './export-order.mjs';

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

const controlIds = ['sAlignH', 'sAlignV', 'sAlignLeft', 'sAlignCenter', 'sAlignRight', 'sNormScale', 'sNormWidth', 'sNormHeight'];
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
  invalidateWorkspaceBBox: () => {},
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
  idsIncludeLockedGroupItems: () => false,
  expandMoveIds: ids => ids,
  toast: () => {},
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

/* Align left / center / right move whole rows, so a board of scenes lines up
   at the start of each row while every row keeps its own spacing. Groups move
   with their children, and nothing moves up or down. */
const rowCalls = { undo: 0, sync: 0, save: 0, invalidate: 0, toasts: [] };
const rowState = { items: [], sel: new Set() };
const rowContext = {
  state: rowState,
  selectedItems: () => rowState.items.filter(item => rowState.sel.has(item.id)),
  byId: id => rowState.items.find(item => item.id === id),
  boundsOf: rotatedBounds,
  isArrowItem: item => item.kind === 'arrow',
  isGroupItem: item => item.kind === 'group',
  isGroupableItem: item => item.kind === 'image' || item.kind === 'note',
  isAnnotationItem: item => item.kind === 'arrow' || item.kind === 'ink',
  childrenOfGroup: id => rowState.items.filter(item => item.groupId === id),
  rowAlignShifts,
  pushUndo: () => rowCalls.undo++,
  syncGroupFramesForItems: () => rowCalls.sync++,
  invalidateWorkspaceBBox: () => {},
  scheduleSave: () => rowCalls.save++,
  invalidate: () => rowCalls.invalidate++,
  toast: message => rowCalls.toasts.push(message),
};
vm.runInNewContext(`
  ${extractFunction('translateAlignedItem')}
  ${extractFunction('expandMoveIds')}
  ${extractFunction('isInLockedGroup')}
  ${extractFunction('idsIncludeLockedGroupItems')}
  ${extractFunction('alignSelectionRows')}
  this.alignSelectionRows = alignSelectionRows;
`, rowContext);

const sceneBoard = [
  { id: 'sc1', kind: 'group', x: 60, y: 0, w: 200, h: 120 },
  { id: 'sc1-a', kind: 'image', groupId: 'sc1', x: 70, y: 10, w: 80, h: 100 },
  { id: 'sc1-b', kind: 'image', groupId: 'sc1', x: 170, y: 10, w: 80, h: 100 },
  { id: 'sc2', kind: 'image', x: 280, y: 0, w: 200, h: 120 },
  { id: 'sc6', kind: 'group', x: 0, y: 160, w: 180, h: 120 },
  { id: 'sc6-a', kind: 'image', groupId: 'sc6', x: 10, y: 170, w: 160, h: 100 },
  { id: 'sc7', kind: 'image', x: 200, y: 160, w: 300, h: 120 },
];
const allScenes = ['sc1', 'sc2', 'sc6', 'sc7'];
let board = [];
const xOf = (...ids) => ids.map(id => board.find(item => item.id === id).x);
function resetRows(selected, items = sceneBoard) {
  board = rowState.items = structuredClone(items);
  rowState.sel = new Set(selected);
  rowCalls.undo = rowCalls.sync = rowCalls.save = rowCalls.invalidate = 0;
  rowCalls.toasts.length = 0;
}

resetRows(allScenes);
rowContext.alignSelectionRows('left');
assert.deepEqual(xOf('sc1', 'sc1-a', 'sc1-b', 'sc2'), [0, 10, 110, 220], 'left: the first row slides as one block, children with their group');
assert.deepEqual(xOf('sc6', 'sc6-a', 'sc7'), [0, 10, 200], 'left: the row already at the edge stays');
assert.ok(board.every(item => item.y === sceneBoard.find(start => start.id === item.id).y), 'row alignment never moves anything up or down');
assert.deepEqual([rowCalls.undo, rowCalls.sync, rowCalls.save, rowCalls.invalidate], [1, 1, 1, 1], 'row alignment is one undoable saved step');

rowCalls.undo = 0;
rowContext.alignSelectionRows('left');
assert.deepEqual(rowCalls.toasts, ['Already aligned']);
assert.equal(rowCalls.undo, 0, 'aligning rows that already line up must not cost an undo step');

resetRows(allScenes);
rowContext.alignSelectionRows('right');
assert.deepEqual(xOf('sc1', 'sc1-a', 'sc2', 'sc6', 'sc7'), [80, 90, 300, 0, 200], 'right: the shorter row slides to the shared right edge');

resetRows(allScenes);
rowContext.alignSelectionRows('center');
assert.deepEqual(xOf('sc1', 'sc2', 'sc6', 'sc7'), [40, 260, 0, 200], 'center: rows centre on the middle of the selection');

resetRows(['sc1', 'sc1-a', ...allScenes.slice(1)]);
rowContext.alignSelectionRows('left');
assert.deepEqual(xOf('sc1', 'sc1-a'), [0, 10], 'a child selected along with its group moves once, with the group');

resetRows(allScenes, sceneBoard.map(item => (item.id === 'sc6' ? { ...item, locked: true } : item)));
rowContext.alignSelectionRows('right');
assert.deepEqual(rowCalls.toasts, ['Group is locked']);
assert.deepEqual([rowCalls.undo, ...xOf('sc1', 'sc2')], [0, 60, 280], 'nothing moves while a locked group is selected');

resetRows(['sc1', 'sc2']);
rowContext.alignSelectionRows('left');
assert.deepEqual(rowCalls.toasts, ['Select two or more rows to align']);
assert.equal(rowCalls.undo, 0, 'a single row has nothing to line up with');

for (const align of ['left', 'center', 'right']) {
  const id = `sAlign${align[0].toUpperCase()}${align.slice(1)}`;
  assert.ok(html.includes(`{ l: 'Align ${align}', f: () => alignSelectionRows('${align}') }`), `the Alignment submenu offers Align ${align}`);
  assert.ok(html.includes(`$('#${id}').addEventListener('click', () => alignSelectionRows('${align}'));`), `#${id} aligns rows ${align}`);
}

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
assert.match(html, /resizeCursorForHandle\(h, h\.group \? selectionFrameRot\(\) : \(h\.it\?\.rot \|\| 0\)\)/, 'the multi-selection box carries its own angle, so its cursors follow the frame');

console.log('selection tool contract tests passed');
