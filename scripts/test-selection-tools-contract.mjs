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

const controlIds = ['sAlignH', 'sAlignV', 'sArrangeGrid', 'sAlignLeft', 'sAlignCenter', 'sAlignRight', 'sMatchSize'];
for (const id of controlIds) {
  const match = html.match(new RegExp(`<button[^>]*id=["']${id}["'][\\s\\S]*?<\\/button>`));
  assert.ok(match, `${id} should remain in the selection bar`);
  assert.match(match[0], /<svg\b/, `${id} should use an inline theme-aware SVG`);
  assert.doesNotMatch(match[0], /tb-icon-img|<img\b/, `${id} should not use the retired bitmap icon style`);
}

/* The multi-select bar reads as three labelled jobs, each set off by a
   separator: Arrange (row, column, grid), Line up rows (left, center, right)
   and Match size, one button with a menu. The three old Normalize buttons are
   gone; their actions live in that menu. */
const barStart = html.indexOf('<div id="selbar" class="pill">');
const barHtml = html.slice(barStart, html.indexOf('<div id="tagPanel"', barStart));
for (const id of ['sNormScale', 'sNormWidth', 'sNormHeight']) {
  assert.ok(!html.includes(`id="${id}"`), `#${id} was folded into Match size`);
}
const barOrder = [...barHtml.matchAll(/<(?:button|span)[^>]*?(?:id="(s\w+)"|class="sep ([\w-]+)")/g)]
  .map(m => m[1] || `sep:${m[2]}`)
  .filter(token => /^(sep:|sAlign|sArrange|sMatch)/.test(token));
assert.deepEqual(barOrder.slice(0, 11), [
  'sep:sel-multi-only', 'sAlignH', 'sAlignV', 'sArrangeGrid',
  'sep:sel-multi-only', 'sAlignLeft', 'sAlignCenter', 'sAlignRight',
  'sep:sel-images-multi-only', 'sMatchSize', 'sep:sel-group-only',
], 'Arrange, Line up rows and Match size sit in that order, each behind a separator');
const tipOf = id => barHtml.match(new RegExp(`id="${id}" data-tip="([^"]+)"`))?.[1];
assert.deepEqual(
  ['sAlignH', 'sAlignV', 'sArrangeGrid', 'sAlignLeft', 'sAlignCenter', 'sAlignRight', 'sMatchSize'].map(tipOf),
  ['Arrange in a row', 'Arrange in a column', 'Arrange in a grid', 'Line up rows: left', 'Line up rows: center', 'Line up rows: right', 'Match size'],
);
assert.match(barHtml, /class="tb tb-menu sel-images-multi-only" id="sMatchSize"[^>]*aria-haspopup="menu"/, 'Match size is for two or more images and opens a menu');

assert.match(html, /function normalizeImagesByWidth\(\) \{ normalizeImagesBy\(['"]width['"]\); \}/);
assert.match(html, /function normalizeImagesByHeight\(\) \{ normalizeImagesBy\(['"]height['"]\); \}/);
const popHtml = html.slice(html.indexOf('<div id="matchSizePop"'), html.indexOf('<div id="selbar"'));
const popEntries = [...popHtml.matchAll(/data-match="(\w+)"[\s\S]*?<span>([^<]+)<\/span><span class="k">([^<]+)<\/span>/g)]
  .map(m => [m[1], m[2], m[3]]);
assert.deepEqual(popEntries, [
  ['height', 'Same height', 'shrinks to the shortest'],
  ['width', 'Same width', 'shrinks to the narrowest'],
  ['scale', 'Same size', 'longest sides match'],
], 'the Match size menu lists the three matches with a one-line hint each');
const setupPop = extractFunction('setupMatchSizePop');
assert.match(setupPop, /height: normalizeImagesByHeight, width: normalizeImagesByWidth, scale: normalizeImagesByScale/);
assert.match(setupPop, /closeMatchSizePop\(\);\s*actions\[entry\.dataset\.match\]\(\);/, 'picking an entry closes the menu');
assert.ok(html.includes("if (!e.target.closest('#sMatchSize') && !e.target.closest('#matchSizePop')) closeMatchSizePop();"), 'an outside click closes the menu');
assert.ok(html.includes("if ($('#matchSizePop')?.classList.contains('open')) { closeMatchSizePop(); return; }"), 'Esc closes the menu first');

// The right-click menu uses the bar's words.
assert.ok(html.includes("entries.push({ l: 'Arrange', sub: 'arrange' });"), 'context menu should expose the Arrange submenu');
assert.ok(html.includes("entries.push({ l: 'Match size', sub: 'matchsize' });"), 'context menu should expose the Match size submenu');
assert.ok(html.includes("{ l: 'Arrange in a row', f: alignSelectionHorizontal }"));
assert.ok(html.includes("{ l: 'Arrange in a column', f: alignSelectionVertical }"));
assert.ok(html.includes("{ l: 'Arrange in a grid', f: arrangeSelectionGrid }"));
assert.ok(html.includes("{ l: 'Same height', k: 'shrinks to the shortest', f: normalizeImagesByHeight }"));
assert.ok(html.includes("{ l: 'Same width', k: 'shrinks to the narrowest', f: normalizeImagesByWidth }"));
assert.ok(html.includes("{ l: 'Same size', k: 'longest sides match', f: normalizeImagesByScale }"));
assert.ok(!/'Align horizontal'|'Align vertical'|'Normalize (scale|width|height)'/.test(html), 'the old menu wording is gone');
assert.ok(html.includes("$('#sArrangeGrid').addEventListener('click', arrangeSelectionGrid);"));

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
assert.deepEqual(calls.toasts, ['Same size · 2 images'], 'the toast uses the Match size words');

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
  assert.ok(html.includes(`{ l: 'Line up rows: ${align}', f: () => alignSelectionRows('${align}') }`), `the Arrange submenu offers Line up rows: ${align}`);
  assert.ok(html.includes(`$('#${id}').addEventListener('click', () => lineUpRowsFromBar('${align}'));`), `#${id} lines rows up ${align}`);
}

/* The Line up buttons dim when the selection has fewer than two rows, and a
   click on a dimmed one does nothing. Very large selections skip the check
   and leave the answer to the click. */
const lineUpState = { sel: new Set(), items: [] };
const lineUpButtons = Object.fromEntries(['sAlignLeft', 'sAlignCenter', 'sAlignRight'].map(id => {
  const attrs = { 'aria-label': `Line up rows: ${id.slice(6).toLowerCase()}` };
  return [id, { dataset: {}, attrs, getAttribute: name => attrs[name], setAttribute: (name, value) => { attrs[name] = value; } }];
}));
const lineUpCalls = [];
const lineUpContext = {
  state: lineUpState,
  $: selector => lineUpButtons[selector.slice(1)],
  selectedItems: () => lineUpState.items.filter(item => lineUpState.sel.has(item.id)),
  boundsOf: rotatedBounds,
  isAnnotationItem: item => item.kind === 'arrow' || item.kind === 'ink',
  rowAlignShifts,
  alignSelectionRows: align => lineUpCalls.push(align),
};
assert.match(html, /const LINE_UP_CHECK_LIMIT = 300;/);
vm.runInNewContext(`
  const LINE_UP_CHECK_LIMIT = 300;
  const LINE_UP_BUTTON_IDS = ['sAlignLeft', 'sAlignCenter', 'sAlignRight'];
  ${extractFunction('selectionHasRowsToLineUp')}
  ${extractFunction('syncLineUpButtons')}
  ${extractFunction('lineUpRowsFromBar')}
  this.syncLineUpButtons = syncLineUpButtons;
  this.lineUpRowsFromBar = lineUpRowsFromBar;
`, lineUpContext);
function selectForLineUp(ids, items = sceneBoard) {
  lineUpState.items = structuredClone(items);
  lineUpState.sel = new Set(ids);
  lineUpCalls.length = 0;
}
selectForLineUp(['sc1', 'sc2']);
assert.equal(lineUpContext.syncLineUpButtons(), false, 'one row is not enough to line up');
assert.equal(lineUpButtons.sAlignLeft.attrs['aria-disabled'], 'true');
assert.equal(lineUpButtons.sAlignCenter.dataset.tip, 'Line up rows: select two or more rows', 'a dimmed button says why');
lineUpContext.lineUpRowsFromBar('left');
assert.deepEqual(lineUpCalls, [], 'a click on a dimmed button does nothing');
selectForLineUp(allScenes);
assert.equal(lineUpContext.syncLineUpButtons(), true, 'two rows can line up');
assert.equal(lineUpButtons.sAlignRight.attrs['aria-disabled'], 'false');
assert.equal(lineUpButtons.sAlignRight.dataset.tip, 'Line up rows: right', 'an enabled button keeps its own tooltip');
lineUpContext.lineUpRowsFromBar('center');
assert.deepEqual(lineUpCalls, ['center']);
selectForLineUp(['sc1', 'sc1-a', 'sc1-b']);
assert.equal(lineUpContext.syncLineUpButtons(), false, 'a group with its own children is one block, so one row');
const crowd = Array.from({ length: 301 }, (_, i) => ({ id: `n${i}`, kind: 'image', x: i * 10, y: 0, w: 8, h: 8 }));
selectForLineUp(crowd.map(item => item.id), crowd);
assert.equal(lineUpContext.syncLineUpButtons(), true, 'past the limit the bar skips the check and lets the click decide');

/* Arrange in a grid packs only the selection into a compact block that keeps
   the selection's top-left corner. Groups move with their children, a mark on
   an item rides along with it, and a locked group refuses. */
const gridCalls = { undo: 0, sync: 0, save: 0, invalidate: 0, toasts: [] };
const gridState = { items: [], sel: new Set() };
const gridContext = {
  state: gridState,
  selectedItems: () => gridState.items.filter(item => gridState.sel.has(item.id)),
  byId: id => gridState.items.find(item => item.id === id),
  boundsOf: item => (item.kind === 'arrow'
    ? { x: Math.min(item.x1, item.x2), y: Math.min(item.y1, item.y2), w: Math.abs(item.x2 - item.x1), h: Math.abs(item.y2 - item.y1) }
    : rotatedBounds(item)),
  isArrowItem: item => item.kind === 'arrow',
  isGroupItem: item => item.kind === 'group',
  isGroupableItem: item => item.kind === 'image' || item.kind === 'note',
  isAnnotationItem: item => item.kind === 'arrow' || item.kind === 'ink',
  childrenOfGroup: id => gridState.items.filter(item => item.groupId === id),
  pushUndo: () => gridCalls.undo++,
  syncGroupFramesForItems: () => gridCalls.sync++,
  invalidateWorkspaceBBox: () => {},
  scheduleSave: () => gridCalls.save++,
  invalidate: () => gridCalls.invalidate++,
  toast: message => gridCalls.toasts.push(message),
};
vm.runInNewContext(`
  ${extractFunction('gridBBox')}
  ${extractFunction('packItems')}
  ${extractFunction('translateAlignedItem')}
  ${extractFunction('expandMoveIds')}
  ${extractFunction('isInLockedGroup')}
  ${extractFunction('idsIncludeLockedGroupItems')}
  ${extractFunction('arrangeSelectionGrid')}
  this.arrangeSelectionGrid = arrangeSelectionGrid;
`, gridContext);
const scattered = [
  { id: 'g', kind: 'group', x: 100, y: 50, w: 220, h: 120 },
  { id: 'g-a', kind: 'image', groupId: 'g', x: 110, y: 60, w: 90, h: 100 },
  { id: 'g-b', kind: 'image', groupId: 'g', x: 220, y: 60, w: 90, h: 100 },
  { id: 'p', kind: 'image', x: 900, y: 700, w: 160, h: 120 },
  { id: 'q', kind: 'image', x: 140, y: 1200, w: 100, h: 150 },
  { id: 'mark', kind: 'arrow', x1: 920, y1: 740, x2: 1000, y2: 780 },
  { id: 'loose', kind: 'arrow', x1: 500, y1: 400, x2: 560, y2: 420 },
  { id: 'other', kind: 'image', x: 2000, y: 2000, w: 50, h: 50 },
];
const gridAt = id => gridState.items.find(item => item.id === id);
function resetGrid(ids, items = scattered) {
  gridState.items = structuredClone(items);
  gridState.sel = new Set(ids);
  gridCalls.undo = gridCalls.sync = gridCalls.save = gridCalls.invalidate = 0;
  gridCalls.toasts.length = 0;
}
resetGrid(['g', 'g-a', 'p', 'q', 'mark', 'loose']);
gridContext.arrangeSelectionGrid();
const packed = ['g', 'p', 'q'].map(gridAt);
assert.equal(Math.min(...packed.map(item => item.x)), 100, 'the block keeps the selection\'s left edge');
assert.equal(Math.min(...packed.map(item => item.y)), 50, 'the block keeps the selection\'s top edge');
for (let i = 0; i < packed.length; i++) {
  for (let j = i + 1; j < packed.length; j++) {
    const [a, b] = [packed[i], packed[j]];
    const overlaps = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    assert.ok(!overlaps, `${a.id} and ${b.id} must not overlap after packing`);
  }
}
const blockW = Math.max(...packed.map(item => item.x + item.w)) - 100;
const blockH = Math.max(...packed.map(item => item.y + item.h)) - 50;
assert.ok(blockW < 500 && blockH < 500, `the block is compact, got ${blockW}×${blockH}`);
const groupShift = [gridAt('g').x - 100, gridAt('g').y - 50];
assert.deepEqual([gridAt('g-a').x - 110, gridAt('g-a').y - 60], groupShift, 'a selected child moves once, with its group');
assert.deepEqual([gridAt('g-b').x - 220, gridAt('g-b').y - 60], groupShift, 'an unselected child still moves with its group');
assert.deepEqual([gridAt('mark').x1 - 920, gridAt('mark').y1 - 740], [gridAt('p').x - 900, gridAt('p').y - 700], 'a mark on an image rides along with it');
assert.deepEqual([gridAt('loose').x1, gridAt('loose').y1], [500, 400], 'a mark between items stays put');
assert.deepEqual([gridAt('other').x, gridAt('other').y], [2000, 2000], 'unselected items are untouched');
assert.deepEqual([gridCalls.undo, gridCalls.sync, gridCalls.save, gridCalls.invalidate], [1, 1, 1, 1], 'arranging in a grid is one undoable saved step');

const afterFirst = structuredClone(gridState.items);
gridCalls.undo = 0;
gridContext.arrangeSelectionGrid();
assert.deepEqual(gridState.items, afterFirst, 'arranging an arranged selection changes nothing');
assert.deepEqual([gridCalls.undo, gridCalls.toasts.at(-1)], [0, 'Already arranged']);

resetGrid(['g', 'p'], scattered.map(item => (item.id === 'g' ? { ...item, locked: true } : item)));
gridContext.arrangeSelectionGrid();
assert.deepEqual([gridCalls.undo, gridCalls.toasts], [0, ['Group is locked']], 'a locked group refuses');
assert.equal(gridAt('p').x, 900);

resetGrid(['p', 'mark']);
gridContext.arrangeSelectionGrid();
assert.deepEqual([gridCalls.undo, gridCalls.toasts], [0, ['Select two or more items to arrange']], 'marks do not count as items to arrange');

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
