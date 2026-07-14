import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

const drawPanelStart = html.indexOf('<div id="drawPanelWrap"');
const drawPanelEnd = html.indexOf('<div id="drawCanvasPop"', drawPanelStart);
assert.ok(drawPanelStart >= 0 && drawPanelEnd > drawPanelStart, 'draw panel markup should exist');
const drawPanel = html.slice(drawPanelStart, drawPanelEnd);

assert.doesNotMatch(html, /id=["']drawBlankBtn["']/, 'Draw panel must not contain a duplicate blank-canvas control');
assert.doesNotMatch(html, /\$\(['"]#drawBlankBtn['"]\)/, 'removed blank-canvas control must not retain a handler');

assert.match(html, /id=["']addCanvasBtn["']/, 'Add panel must retain the Canvas control');
assert.match(html, /openDrawCanvasPop\(\$\(['"]#addCanvasBtn['"]\)\)/, 'Add Canvas must still open the aspect-ratio menu');
assert.equal((html.match(/id=["']addCanvasBtn["']/g) ?? []).length, 1, 'Add Canvas control should be unique');
assert.equal((html.match(/class=["'][^"']*draw-ratio-btn[^"']*["']/g) ?? []).length, 3, 'Canvas menu should retain all three aspect ratios');

const controls = [
  'drawModeBtn',
  'drawPen',
  'drawEraser',
  'drawColorBtn',
  'drawWidthDown',
  'drawWidthUp',
  'annotateHeadBtn',
  'arrowSolidBtn',
  'arrowDottedBtn',
  'drawBrushPen',
  'drawBrushSoft',
  'drawBrushMarker',
  'drawBrushPencil',
];
for (const id of controls) {
  assert.equal((drawPanel.match(new RegExp(`id=["']${id}["']`, 'g')) ?? []).length, 1, `${id} should remain present exactly once`);
}

const handlerContracts = [
  /\$\(['"]#drawModeBtn['"]\)\.addEventListener\(['"]click['"], toggleDrawActive\)/,
  /\$\(['"]#drawPen['"]\)\.addEventListener\(['"]click['"]/,
  /\$\(['"]#drawEraser['"]\)\.addEventListener\(['"]click['"]/,
  /\$\(['"]#drawColorBtn['"]\)\?\.addEventListener\(['"]pointerdown['"]/,
  /\$\(['"]#drawWidthDown['"]\)\.addEventListener\(['"]click['"]/,
  /\$\(['"]#drawWidthUp['"]\)\.addEventListener\(['"]click['"]/,
  /\$\(['"]#annotateHeadBtn['"]\)\?\.addEventListener\(['"]click['"]/,
  /\$\(['"]#arrowSolidBtn['"]\)\.addEventListener\(['"]click['"]/,
  /\$\(['"]#arrowDottedBtn['"]\)\.addEventListener\(['"]click['"]/,
  /\$\(['"]#drawBrushDrawer['"]\)\?\.addEventListener\(['"]click['"]/,
  /e\.target\.closest\(['"]\[data-brush\]['"]\)/,
  /function adjustDrawWidth\(delta, showPreview = false\)/,
  /drawActive && k === ['"]e['"]/,
  /drawActive && \(e\.key === ['"]\[['"] \|\| e\.key === ['"]\]['"]\)/,
  /adjustDrawWidth\(e\.key === ['"]\[['"] \? -1 : 1, true\)/,
];
for (const contract of handlerContracts) {
  assert.match(html, contract, `missing drawing-control handler: ${contract}`);
}

assert.match(html, /const drawToolWidths = \{ pen: 2, eraser: 15 \}/, 'brush and eraser should keep independent default sizes');
assert.match(html, /drawWidth = drawToolWidths\[tool\]/, 'tool switching should restore the remembered size');
assert.match(html, /id=["']drawSizePreview["']/, 'animated size preview should remain mounted over the board');
assert.match(html, /data-tip-sub=["']E["']/, 'eraser should advertise its keyboard shortcut');
assert.match(html, /data-tip-sub=["']\[["']/, 'thinner control should advertise the opening-bracket shortcut');
assert.match(html, /data-tip-sub=["']\]["']/, 'thicker control should advertise the closing-bracket shortcut');

console.log('draw panel contract tests passed');
