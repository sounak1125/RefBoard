/* Contract test for the content-aware fill feature.
 *
 * Asserts the wiring between the renderer, the worker and the packaging — the
 * things that unit tests on the engine cannot see. The engine's behaviour is
 * covered by test-content-aware-{mask,sampling,patchmatch,blend,scenes,
 * regressions}.mjs.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { moduleOrder } from './content-aware-harness.mjs';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const preload = await readFile(new URL('../preload.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('./content-aware/fill-worker.js', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/* --- the feature is offline and non-generative (§42) -------------------- */
{
  const files = await readdir(new URL('./content-aware/', import.meta.url));
  const sources = await Promise.all(files
    .filter(f => f.endsWith('.js'))
    .map(async f => [f, await readFile(new URL(`./content-aware/${f}`, import.meta.url), 'utf8')]));

  for (const [name, source] of sources) {
    assert.doesNotMatch(source, /onnxruntime|require\(|\bimport\s+[\w{*]/,
      `${name} must stay dependency-free so importScripts and vm can both load it`);
    assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|WebSocket|https?:\/\/[^\s*]/,
      `${name} must not reach the network`);
  }

  // No trace of the generative pipeline may remain anywhere in the app.
  for (const [label, source] of [['index.html', html], ['main.js', main], ['preload.js', preload]]) {
    assert.doesNotMatch(source, /onnxruntime|ContentAwareInferenceQueue|ContentAwareModelManager/,
      `${label} must not reference the removed model runtime`);
    assert.doesNotMatch(source, /content-aware-model-(status|reconcile|retry)|content-aware-analysis-(run|cancel)/,
      `${label} must not reference the removed model IPC`);
  }
  assert.ok(!pkg.dependencies['onnxruntime-node'], 'onnxruntime-node must not be a dependency');
  assert.ok(!Object.keys(pkg.dependencies).some(d => /onnx|torch|diffus/i.test(d)),
    'no inference runtime may be a dependency');
  assert.doesNotMatch(JSON.stringify(pkg.build), /onnxruntime|content-aware-model/,
    'no model asset may be packaged');
}

/* --- module set and load order (§30) ------------------------------------ */
{
  const order = await moduleOrder();
  for (const required of [
    'common.js', 'options.js', 'mask-processor.js', 'sampling-area.js',
    'structure-analyzer.js', 'confidence.js', 'image-pyramid.js', 'nnf.js',
    'patch-distance.js', 'patchmatch.js', 'patch-voting.js', 'shift-labeling.js',
    'color-adapter.js', 'seam-blender.js', 'inpaint-fallback.js',
    'quality-report.js', 'debug-capture.js', 'content-aware-fill.js',
  ]) {
    assert.ok(order.includes(required), `${required} must be loaded by the worker`);
  }
  assert.ok(order.indexOf('common.js') === 0, 'shared primitives load first');
  assert.ok(order.indexOf('content-aware-fill.js') === order.length - 1,
    'the orchestrator loads last, after everything it calls');
  assert.ok(order.indexOf('patch-distance.js') < order.indexOf('patchmatch.js'),
    'scoring is defined before the search that uses it');
}

/* --- the worker protocol (§27, §31) ------------------------------------- */
{
  assert.match(worker, /importScripts\(/, 'modules load through importScripts');
  assert.match(worker, /type: 'progress', id, stage, percent/, 'progress carries a named stage');
  assert.match(worker, /type: 'result', id, result/, 'results come back typed');
  assert.match(worker, /type: 'error', ?\n?\s*id,?\n?\s*cancelled/, 'errors distinguish cancellation');
  assert.match(worker, /message\.type === 'cancel'/, 'a cancel message is understood');
  assert.match(worker, /timeBudgetMs/, 'a time budget bounds the run');
  assert.match(worker, /stageChanged/, 'a stage change is never throttled away');
}

/* --- renderer wiring ----------------------------------------------------- */
{
  assert.match(html, /id="btnFill"[\s\S]*?Content-aware fill/, 'the fill tool remains available');
  assert.match(html, /id="fillPreviewBar"/, 'results use the preview bar');
  for (const id of ['fillApply', 'fillRetry', 'fillCancel', 'fillAutoFeather', 'fillFeather',
    'fillQuality', 'fillSampling']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} must exist`);
  }
  assert.match(html, /type="range" min="0" max="128"/, 'feather covers 0-128 source pixels');
  assert.match(html, /CONTENT_AWARE_WORKER_URL = '\.\/scripts\/content-aware\/fill-worker\.js/,
    'the renderer runs the exemplar worker');
  assert.match(html, /new Worker\(CONTENT_AWARE_WORKER_URL\)/, 'and constructs it as a classic worker');
  assert.match(html, /CONTENT_AWARE_MAX_WORKING_PIXELS = 3840 \* 2160/,
    'the worker is not asked to solve native frames above 4K');
  assert.match(html, /function contentAwareWorkingSize\(/, 'oversized crops pick a working size');
  assert.match(html, /function resizeRgbaForFill\(/, 'colour is scaled with the working size');
  assert.match(html, /function resizePlaneNearest\(/, 'masks are scaled with nearest neighbour');
  assert.match(html, /const working = contentAwareWorkingSize\(srcW, srcH\)/,
    'the host downscales before posting to the worker');
  assert.match(html, /outPixels = resizeRgbaForFill\(outPixels, workW, workH, srcW, srcH\)/,
    'and scales the result back to crop space');
  assert.match(main, /render-process-gone/,
    'a renderer crash reloads the window instead of leaving the app dead');
  assert.match(html, /worker\.postMessage\(\{\s*\n?\s*type: 'fill'/, 'it posts a typed fill job');
  assert.match(html, /\[pixels\.buffer, mask\.buffer\]/, 'heavy buffers are transferred, not copied');
  assert.match(html, /data\.type === 'progress'/, 'progress updates drive the status bar');
  assert.match(html, /worker\.postMessage\(\{ type: 'cancel', id: jobId \}\)/,
    'a timed-out job is asked to cancel');
  assert.match(html, /worker\.terminate\(\)/, 'and terminated');

  // Preserved behaviour from the previous implementation.
  assert.match(html, /await ensureFullBitmap\(im\)/, 'fill decodes the full bitmap first');
  assert.match(html, /session\.autoFeather = autoFeatherForFill\(/, 'auto feather is derived per session');
  assert.match(html, /fillSession\?\.it\?\.id === it\.id && fillSession\.previewCanvas/,
    'the board previews without touching the image record');
  assert.match(html, /toBlob\(resolve, 'image\/png'\)/, 'Apply encodes lossless PNG');
  assert.match(html, /pushUndo\(\{ imgId: session\.imId, blob: session\.undoBlob \}\)/,
    'Apply creates one bitmap undo entry');
}

/* --- compositing keeps pixels outside the mask (§22) -------------------- */
{
  assert.match(html, /function outwardFeatherAlpha\(/, 'feather alpha comes from a distance field');
  assert.match(html, /if \(mask\[i\]\) alpha\[i\] = 255/, 'the hard mask is fully replaced');
  assert.match(html, /if \(!a\) continue;/, 'pixels outside mask-plus-feather are never rewritten');
}

/* --- quality presets (§26) ---------------------------------------------- */
{
  assert.match(html, /CONTENT_AWARE_QUALITY_PRESETS = \['preview', 'balanced', 'high'\]/,
    'the three presets §26 names are the ones offered');
  assert.match(html, /function setFillQuality\(/, 'the preset is selectable');
  assert.match(html, /quality: session\.quality \|\| 'balanced'/, 'and travels to the engine');
}

/* --- sampling area (§17) ------------------------------------------------- */
{
  assert.match(html, /function paintSamplingArea\(/, 'the sampling area is paintable');
  assert.match(html, /function drawSamplingOverlay\(/, 'and shown as an overlay');
  assert.match(html, /samplingMask = scaled[\s\S]*?session\.samplingMask\.slice\(\)/,
    'the painted area is sent to the engine');
  assert.match(html, /transfer\.push\(samplingMask\.buffer\)/, 'transferred like the other buffers');
  assert.match(html, /mode = \{ type: 'samplingPaint'/, 'painting is its own pointer mode');
  assert.match(html, /session\.samplingMask\.length !== bounds\.cropW \* bounds\.cropH/,
    'a sampling mask from a different crop is discarded rather than misapplied');
}

/* --- canvas extension (§24) ---------------------------------------------- */
{
  assert.match(html, /async function startContentAwareExpand\(/, 'canvas extension exists');
  assert.match(html, /function restoreExpandGeometry\(/, 'and can be undone geometrically');
  assert.match(html, /if \(session\.expand\) await revertExpandSession\(session\)/,
    'cancelling an expansion restores the original bitmap');
  assert.match(html, /mode\.expandLocal/, 'an outward crop drag proposes new canvas');
  assert.match(html, /restoreExpandGeometry\(session\);\s*\n\s*pushUndo\(/,
    'undo records the pre-expansion geometry, since undo() applies the entry it pops');

  /* Regression: restoring a history bitmap must take its dimensions from the
   * decoded image. Every other pixel edit leaves them unchanged, so this was
   * safe to skip until canvas extension started changing them — after which
   * undo left the record claiming the expanded size and sampling the restored
   * bitmap through the wrong source rectangle. */
  assert.match(html, /im\.bitmap = bitmap;[\s\S]{0,600}?im\.w = bitmap\.width;\s*\n\s*im\.h = bitmap\.height;/,
    'restoreBitmapSnap must adopt the restored bitmap dimensions');
}

/* --- debug mode (§33) ----------------------------------------------------- */
{
  assert.match(html, /dumpContentAwareDebug/, 'intermediates can be exported');
  assert.match(html, /debug: !!window\.__contentAwareDebug/, 'and are off unless explicitly enabled');
  assert.doesNotMatch(html, /id="fillDebug"/, 'debug capture is not exposed in the interface');
}

/* --- packaging ------------------------------------------------------------ */
{
  assert.ok(pkg.build?.files?.includes('scripts/content-aware/**'),
    'the engine modules must ship');
  assert.ok(!pkg.build?.files?.some(f => /content-aware-(fill|refine|analysis)-worker/.test(f)),
    'no superseded worker may ship');
  const testScript = pkg.scripts.test;
  for (const t of ['test-content-aware-fill.mjs', 'test-content-aware-mask.mjs',
    'test-content-aware-sampling.mjs', 'test-content-aware-patchmatch.mjs',
    'test-content-aware-blend.mjs', 'test-content-aware-composite.mjs',
    'test-content-aware-regressions.mjs', 'test-content-aware-scenes.mjs']) {
    assert.ok(testScript.includes(t), `${t} must run in npm test`);
  }
  assert.ok(!/model:verify|content-aware-model-smoke/.test(JSON.stringify(pkg.scripts)),
    'model tooling must be gone');
}

/* --- working-size cap ---------------------------------------------------- */
{
  const start = html.indexOf('const CONTENT_AWARE_MAX_WORKING_PIXELS');
  const end = html.indexOf('function nativeFillContextBounds', start);
  assert.ok(start >= 0 && end > start, 'working-size helpers must sit next to the fill constants');
  const sandbox = { Math, Uint8Array };
  vm.createContext(sandbox);
  vm.runInContext(`${html.slice(start, end)}
    this.CONTENT_AWARE_MAX_WORKING_PIXELS = CONTENT_AWARE_MAX_WORKING_PIXELS;
    this.contentAwareWorkingSize = contentAwareWorkingSize;
    this.resizePlaneNearest = resizePlaneNearest;
  `, sandbox);

  const small = sandbox.contentAwareWorkingSize(1920, 1080);
  assert.equal(small.scale, 1, 'a 1080p crop stays native');
  assert.equal(small.width, 1920);
  assert.equal(small.height, 1080);

  const fourK = sandbox.contentAwareWorkingSize(3840, 2160);
  assert.equal(fourK.scale, 1, 'a 4K crop is the largest native size');

  const huge = sandbox.contentAwareWorkingSize(6000, 4000);
  assert.ok(huge.scale < 1, 'a 24MP crop is reduced');
  assert.ok(huge.width * huge.height <= sandbox.CONTENT_AWARE_MAX_WORKING_PIXELS,
    'the working area never exceeds the 4K budget');
  assert.ok(Math.abs(huge.width / huge.height - 6000 / 4000) < 0.02,
    'aspect ratio is preserved');

  const plane = new Uint8Array([1, 1, 0, 0, 1, 1, 0, 0]);
  const scaled = sandbox.resizePlaneNearest(plane, 4, 2, 2, 1);
  assert.equal(scaled.length, 2);
  assert.equal(scaled[0], 1, 'nearest mask resize keeps hole pixels');
}

console.log('content-aware fill contract tests passed');
