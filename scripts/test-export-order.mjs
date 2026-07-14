import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  finalizeExportFilename,
  paddedSequence,
  reconcileSelectionOrder,
  resolveExportItems,
  sortItemsForExport,
} from './export-order.mjs';

const rect = item => item;
const ids = items => items.map(item => item.id);

const horizontal = [
  { id: 'third', x: 240, y: 12, w: 80, h: 90 },
  { id: 'first', x: 10, y: 10, w: 100, h: 180 },
  { id: 'second', x: 125, y: 14, w: 90, h: 70 },
];
assert.deepEqual(
  ids(sortItemsForExport(horizontal, 'visual', rect)),
  ['first', 'second', 'third'],
  'a visually overlapping row should export left-to-right even with mixed image heights',
);

const vertical = [
  { id: 'bottom', x: 12, y: 250, w: 80, h: 80 },
  { id: 'top', x: 10, y: 10, w: 100, h: 70 },
  { id: 'middle', x: 14, y: 120, w: 60, h: 90 },
];
assert.deepEqual(
  ids(sortItemsForExport(vertical, 'visual', rect)),
  ['top', 'middle', 'bottom'],
  'a vertical arrangement should export top-to-bottom',
);

const grid = [
  { id: 'r2c2', x: 130, y: 130, w: 80, h: 80 },
  { id: 'r1c2', x: 130, y: 10, w: 80, h: 80 },
  { id: 'r2c1', x: 10, y: 130, w: 80, h: 80 },
  { id: 'r1c1', x: 10, y: 10, w: 80, h: 80 },
];
assert.deepEqual(
  ids(sortItemsForExport(grid, 'visual', rect)),
  ['r1c1', 'r1c2', 'r2c1', 'r2c2'],
  'a grid should export row-by-row',
);
assert.deepEqual(
  ids(sortItemsForExport(grid, 'horizontal', rect)),
  ['r1c1', 'r2c1', 'r1c2', 'r2c2'],
  'left-to-right override should use x as the primary axis',
);
assert.deepEqual(
  ids(sortItemsForExport(grid, 'vertical', rect)),
  ['r1c1', 'r1c2', 'r2c1', 'r2c2'],
  'top-to-bottom override should use y as the primary axis',
);

assert.deepEqual(
  reconcileSelectionOrder(['third', 'first'], horizontal, rect),
  ['third', 'first', 'second'],
  'Shift-click order should be retained and newly selected items appended visually',
);
assert.deepEqual(
  reconcileSelectionOrder(['removed', 'third', 'third'], horizontal, rect),
  ['third', 'first', 'second'],
  'deselected and duplicate IDs should not leak into the export order',
);

const group = { id: 'group', kind: 'group', x: 0, y: 0, w: 300, h: 100 };
const groupChildren = [
  { id: 'group-b', kind: 'image', groupId: 'group', x: 150, y: 10, w: 80, h: 80 },
  { id: 'group-note', kind: 'note', groupId: 'group', x: 90, y: 10, w: 40, h: 80 },
  { id: 'group-a', kind: 'image', groupId: 'group', x: 10, y: 10, w: 60, h: 80 },
];
const free = { id: 'free', kind: 'image', x: 400, y: 10, w: 80, h: 80 };
const resolved = resolveExportItems({
  selectedItems: [free, group, groupChildren[0]],
  preferredIds: ['group', 'group-b', 'free'],
  order: 'selection',
  isImage: item => item?.kind === 'image',
  isGroup: item => item?.kind === 'group',
  childrenOfGroup: id => id === 'group' ? groupChildren : [],
  getBounds: rect,
});
assert.deepEqual(
  ids(resolved),
  ['group-a', 'group-b', 'free'],
  'a selected group should expand visually, ignore notes, and deduplicate directly selected children',
);

assert.equal(paddedSequence(1, 9), '01', 'small exports should receive stable two-digit names');
assert.equal(paddedSequence(10, 200), '010', 'hundreds should receive three-digit names');
assert.equal(paddedSequence(3040, 3040), '3040', 'large exports should size padding to the total');
assert.equal(
  finalizeExportFilename('03_3.9B', 'jpg'),
  '03_3.9B.jpg',
  'a dotted image stem must not be mistaken for a file extension',
);
assert.equal(
  finalizeExportFilename('03_shot.001', 'png'),
  '03_shot.001.png',
  'numeric dotted stems should retain every meaningful name segment',
);
assert.equal(
  finalizeExportFilename('custom-name.png', 'jpg'),
  'custom-name.jpg',
  'a manually supplied image extension should match the encoded output format',
);

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert.match(html, /id="expImgOrder"/, 'the Export Images dialog should expose ordering controls');
assert.match(html, /value="%N_%0"/, 'the default naming preset should encode padded export order');
assert.match(html, /resetSelectionOrder\(\[\.\.\.order, it\.id\]\)/, 'Shift-click should append to explicit selection order');
assert.match(html, /reconcileSelectionOrder\(mode\.orderBase, selectedItems\(\), boundsOf\)/, 'marquee should reconcile its visual batch with any kept selection');

console.log('export order tests passed');
