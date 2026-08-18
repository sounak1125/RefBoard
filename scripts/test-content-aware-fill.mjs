import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const worker = await readFile(new URL('./content-aware-fill-worker.js', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Toolbar button
assert.match(html, /id="btnFill"[\s\S]*?Content-aware fill/, 'the fill button must exist in the toolbar');
assert.match(html, /id="btnFill"[\s\S]*?data-tip-sub="C"/, 'the fill button must show the C shortcut');

// State and tool lifecycle
assert.match(html, /let fillActive = false/, 'fillActive state must exist');
assert.match(html, /let fillPrepareSeq = 0/, 'fillPrepareSeq state must exist');
assert.match(html, /let fillSession = null/, 'fillSession state must exist');
assert.match(html, /function setFillActive\(on\)/, 'setFillActive must exist');
assert.match(html, /function toggleFillActive\(\)/, 'toggleFillActive must exist');
assert.match(html, /function syncFillUi\(\)/, 'syncFillUi must exist');
assert.match(html, /function cancelFillSession\(\)/, 'cancelFillSession must exist');

// Fill pipeline
assert.match(html, /function rasterizeFillMask\(/, 'rasterizeFillMask must exist');
assert.match(html, /function downscaleForFill\(/, 'downscaleForFill must exist');
assert.match(html, /function runFillWorker\(/, 'runFillWorker must exist');
assert.match(html, /function commitFillSession\(/, 'commitFillSession must exist');
assert.match(html, /new Worker\('\.\/scripts\/content-aware-fill-worker\.js'\)/, 'the fill pipeline must load the worker script');

// Pointer hook
assert.match(html, /if \(fillActive && e\.button === 0 && !\(spaceDown \|\| altDown \|\| e\.altKey\)\)/,
  'pointerdown must branch for fill before draw/crop/marquee');
assert.match(html, /mode = \{ type: 'fill', it: hit\.id, sx, sy \}/, 'pointerdown must start a fill mode gesture');
assert.match(html, /mode\.type === 'fill'[\s\S]*?fillSession\.pts\.push\(pt\)/, 'pointermove must append lasso points');
assert.match(html, /mode\.type === 'fill'[\s\S]*?commitFillSession\(mode\)/, 'pointerup must auto-commit the fill');

// Undo integration
assert.match(html, /pushUndo\(\{ imgId: fillSession\.imId, blob: fillSession\.undoBlob \}\)/,
  'the fill commit must pushUndo with the pre-edit blob');

// Bake sequence mirrors draw
assert.match(html, /im\.pixelUpdateInProgress = true/, 'fill bake must set pixelUpdateInProgress');
assert.match(html, /imageResidency\.pin\(im\)/, 'fill bake must pin the image residency');
assert.match(html, /im\.bitmap = nextBitmap/, 'fill bake must swap the bitmap');
assert.match(html, /invalidateImageLods\(im, \{ bumpVersion: true \}\)/, 'fill bake must bump the image version');
assert.match(html, /replaceStableImageProxy\(im, blob\)/, 'fill bake must rebuild the stable proxy');
assert.match(html, /persistImageBlob\(im, blob\)/, 'fill bake must persist the blob');
assert.match(html, /imageResidency\.unpin\(im\)/, 'fill bake must unpin the image residency');
assert.match(html, /scheduleFullBitmapEviction\(\)/, 'fill bake must schedule eviction');

// Exclusive edit for shared images
assert.match(html, /prepareExclusiveImageEdit\(hit\)/, 'fill must use exclusive edit preparation');
assert.match(html, /discardDetachedImageEdit\(prepared\)/, 'fill must clean up a detached edit on cancel');

// Shortcuts
assert.match(html, /label:'Content-aware fill', keys:\['C'\]/, 'SHORTCUTS must include the fill tool');
assert.match(html, /<kbd>C<\/kbd><\/span><span class="d">Content-aware fill/, 'help modal must document the fill tool');
assert.match(html, /k === 'escape'[\s\S]*?fillActive\) \{ setFillActive\(false\)/, 'Escape must exit fill mode');
assert.match(html, /k === 'v'\) activateSelectMode\(\)/, 'V must return to select mode');
assert.match(html, /activateSelectMode\(\)[\s\S]*?if \(fillActive\) setFillActive\(false\)/, 'activateSelectMode must clear fill');
assert.match(html, /activateHandTool\(\)[\s\S]*?if \(fillActive\) setFillActive\(false\)/, 'activateHandTool must clear fill');
assert.match(html, /setDrawActive\(true\)[\s\S]*?if \(fillActive\) setFillActive\(false\)/, 'draw mode must clear fill');
assert.match(html, /k === 'c' && !e\.shiftKey[\s\S]*?toggleFillActive\(\)/, 'C must toggle the fill tool');

// Pointer cancel / blur cleanup
assert.match(html, /pointercancel[\s\S]*?fillPrepareSeq\+\+/, 'pointercancel must invalidate fill preparation');
assert.match(html, /pointercancel[\s\S]*?cancelFillSession\(\)/, 'pointercancel must cancel fill');
assert.match(html, /window\.addEventListener\('blur'[\s\S]*?fillPrepareSeq\+\+/, 'blur must invalidate fill preparation');
assert.match(html, /window\.addEventListener\('blur'[\s\S]*?cancelFillSession\(\)/, 'blur must cancel fill');

// Lasso render
assert.match(html, /mode\?\.type === 'fill' && fillSession\?\.pts\?\.length/, 'render must draw the fill lasso outline');
assert.match(html, /localToBoardRect\(it, lx, ly\)/, 'render must map fill points back through crop/flip/rotation');

// Worker contract
assert.match(worker, /self\.onmessage/, 'the worker must listen for messages');
assert.match(worker, /nearestValidFill\(/, 'the worker must implement nearest-valid-pixel inpainting');
assert.match(worker, /postMessage\(\{ pixels: filled/, 'the worker must return filled pixels');
assert.match(worker, /transfer/, 'the worker must use transferable buffers');
assert.ok(worker.includes('Uint8ClampedArray'), 'the worker must handle RGBA pixels');
assert.ok(worker.includes('Uint8Array'), 'the worker must handle a binary mask');

// Build wiring
assert.ok(pkg.build?.files?.includes('scripts/content-aware-fill-worker.js'),
  'the packaged app must include the fill worker');
assert.match(pkg.scripts?.test || '', /test-content-aware-fill\.mjs/, 'npm test must run the fill contract test');
assert.ok(pkg.scripts?.['test:content-aware-fill'], 'a dedicated fill contract script must exist');
assert.ok(pkg.scripts?.['test:content-aware-fill-smoke'], 'a dedicated fill smoke script must exist');

console.log('content-aware fill contract tests passed');
