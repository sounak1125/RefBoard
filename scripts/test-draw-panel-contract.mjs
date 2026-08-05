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
  /function activateDrawShortcut\(tool\)/,
  /k === ['"]d['"][\s\S]*?activateDrawShortcut\(['"]pen['"]\)/,
  /k === ['"]e['"][\s\S]*?activateDrawShortcut\(['"]eraser['"]\)/,
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

assert.match(html, /function imageItemReferenceCount\(imgId\)/, 'drawing should detect shared image records');
assert.match(html, /function prepareExclusiveImageEdit\(it\)/, 'drawing should prepare private image ownership');
assert.match(
  html,
  /if \(imageItemReferenceCount\(sourceImgId\) <= 1\)[\s\S]*?registerBlob\(currentBlob,/,
  'shared images should use copy-on-write while uniquely owned images stay in place',
);
assert.match(
  html,
  /dbPut\('blobs', `pristine:\$\{detachedImgId\}`, pristineBlob\)/,
  'copy-on-write should preserve the pristine pixels used by the eraser',
);
assert.match(
  html,
  /prepared = await prepareExclusiveImageEdit\(hit\);[\s\S]*?hit\.imgId = prepared\.detachedImgId;[\s\S]*?pushUndo\(\{ imgId: hit\.imgId, blob: undoBlob \}\);/,
  'paint and erase should detach the edited board item before recording the mutation',
);
assert.match(
  html,
  /function discardDetachedImageEdit\(prepared\)[\s\S]*?images\.delete\(imgId\);/,
  'abandoned asynchronous draw preparation should clean up private image records',
);
assert.match(html, /let pendingDrawCommit = null;/, 'drawing should track an in-flight bitmap commit');
assert.match(
  html,
  /if \(session\.commitPromise\) return session\.commitPromise;/,
  'repeated draw-finalization signals should share one bitmap commit',
);
assert.match(
  html,
  /async function settleDrawCommitForHistory\(\)[\s\S]*?if \(commit\) await commit;/,
  'board history should have a draw-commit synchronization point',
);
assert.match(
  html,
  /function commitDrawSessionAndSave\(\)[\s\S]*?scheduleSave\(\);[\s\S]*?commitDrawSession\(\)\.then\([\s\S]*?scheduleSave\(false\);/,
  'every completed stroke should mark dirty immediately and persist again after bitmap baking',
);
assert.match(
  html,
  /window\.addEventListener\('pointercancel',[\s\S]*?if \(drawSession\) commitDrawSessionAndSave\(\);/,
  'pointer cancellation should finalize the active drawing session',
);
assert.match(
  html,
  /window\.addEventListener\('blur',[\s\S]*?if \(drawSession\) commitDrawSessionAndSave\(\);/,
  'window blur should finalize and save dot-only drawing sessions',
);
assert.match(
  html,
  /function setArrowTool\(style\)[\s\S]*?setDrawActive\(false\);[\s\S]*?setDrawTool\('pen'\);/,
  'arrow annotations should use the remembered pen width instead of the eraser width',
);
assert.match(
  html,
  /function undo\(\)[\s\S]*?await settleDrawCommitForHistory\(\);[\s\S]*?captureUndoState\(entry\)/,
  'undo should settle drawing before capturing redo state',
);
assert.match(
  html,
  /function redo\(\)[\s\S]*?await settleDrawCommitForHistory\(\);[\s\S]*?captureUndoState\(entry\)/,
  'redo should settle drawing before capturing undo state',
);
assert.match(
  html,
  /\(highQualityDemandAllowed \|\| imagePixelUpdateInProgress\(im\)\) && im\.bitmap/,
  'pixel publication should display the current full bitmap while derived surfaces are rebuilt',
);
assert.match(
  html,
  /function imagePixelUpdateInProgress\(im\)[\s\S]*?im\?\.historyRestoring \|\| im\?\.pixelUpdateInProgress/,
  'history and drawing commits should share one derived-surface publication guard',
);
assert.match(
  html,
  /function isImageLodJobStillNeeded\(job\)[\s\S]*?if \(imagePixelUpdateInProgress\(job\.im\)\) return false;/,
  'pixel publication should cancel stale in-flight LOD work',
);
assert.match(
  html,
  /function queueImageLod\(im, it, bucket\)[\s\S]*?if \(imagePixelUpdateInProgress\(im\)\) return Promise\.resolve\(null\);/,
  'pixel publication should block new LOD work until current pixels are persisted',
);
assert.match(
  html,
  /function getImageLodForDraw\(im, it, cr\)[\s\S]*?if \(imagePixelUpdateInProgress\(im\)\) return null;/,
  'pixel publication should not draw a stale LOD over its current full bitmap',
);
assert.match(
  html,
  /function commitDrawSession\(\)[\s\S]*?im\.pixelUpdateInProgress = true;[\s\S]*?imageResidency\.pin\(im\);[\s\S]*?im\.blob = blob;[\s\S]*?invalidateImageLods\(im, \{ bumpVersion: true \}\);[\s\S]*?await persistImageBlob\(im, blob\);[\s\S]*?im\.pixelUpdateInProgress = false;[\s\S]*?imageResidency\.unpin\(im\);/,
  'draw commit should publish source bytes atomically and retain the full bitmap until derived surfaces are safe',
);

console.log('draw panel contract tests passed');
