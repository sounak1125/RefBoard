/* Contract test for content-aware fill removal from the product.
 *
 * The PatchMatch engine stays in the repo for developer tests; users must not
 * see the tool, launch the worker, or receive the engine in installers.
 * Engine behaviour is covered by test-content-aware-{mask,sampling,patchmatch,
 * blend,composite,regressions,scenes}.mjs.
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { moduleOrder } from './content-aware-harness.mjs';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const preload = await readFile(new URL('../preload.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('./content-aware/fill-worker.js', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

/* --- the engine stays offline and non-generative (§42) -------------------- */
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
}

/* --- the worker protocol (§27, §31) ------------------------------------- */
{
  assert.match(worker, /importScripts\(/, 'modules load through importScripts');
  assert.match(worker, /type: 'progress', id, stage, percent/, 'progress carries a named stage');
  assert.match(worker, /type: 'result', id, result/, 'results come back typed');
  assert.match(worker, /type: 'error', ?\n?\s*id,?\n?\s*cancelled/, 'errors distinguish cancellation');
  assert.match(worker, /message\.type === 'cancel'/, 'a cancel message is understood');
  assert.match(worker, /timeBudgetMs/, 'a time budget bounds the run');
}

/* --- fill UI is gone from the product ----------------------------------- */
{
  assert.doesNotMatch(html, /id="btnFill"/, 'the fill toolbar button must be removed');
  assert.doesNotMatch(html, /id="fillPreviewBar"/, 'the fill preview bar must be removed');
  for (const id of ['fillApply', 'fillRetry', 'fillCancel', 'fillAutoFeather', 'fillFeather',
    'fillQuality', 'fillSampling']) {
    assert.doesNotMatch(html, new RegExp(`id="${id}"`), `${id} must not exist`);
  }
  assert.doesNotMatch(html, /CONTENT_AWARE_WORKER_URL/, 'the renderer must not wire a fill worker');
  assert.doesNotMatch(html, /new Worker\([^)]*fill-worker/, 'fill must not spawn a worker');
  assert.doesNotMatch(html, /toggleFillActive|setFillActive|startContentAwareFill|startContentAwareExpand/,
    'fill session helpers must not remain in the renderer');
  assert.doesNotMatch(html, /Content-aware fill/, 'help and shortcuts must not advertise fill');
  assert.doesNotMatch(html, /else if \(k === 'c' && !mod/, 'bare C must not toggle fill');
  assert.doesNotMatch(html, /else if \(k === 'c' && !e\.shiftKey\)/, 'bare C must not toggle fill');
  assert.match(html, /if \(mod && k === 'c'\)/, 'Ctrl+C copy must remain');
  assert.doesNotMatch(html, /mode\.expandLocal/, 'outward crop expand must be removed');
  assert.match(main, /render-process-gone/,
    'a renderer crash reloads the window instead of leaving the app dead');
}

/* --- packaging ------------------------------------------------------------ */
{
  assert.ok(!pkg.build?.files?.includes('scripts/content-aware/**'),
    'the engine must not ship in installers');
  assert.ok(!pkg.build?.files?.some(f => /content-aware-(fill|refine|analysis)-worker/.test(f)),
    'no superseded worker may ship');
  const testScript = pkg.scripts.test;
  for (const t of ['test-content-aware-fill.mjs', 'test-content-aware-mask.mjs',
    'test-content-aware-sampling.mjs', 'test-content-aware-patchmatch.mjs',
    'test-content-aware-blend.mjs', 'test-content-aware-composite.mjs',
    'test-content-aware-regressions.mjs', 'test-content-aware-scenes.mjs']) {
    assert.ok(testScript.includes(t), `${t} must run in npm test`);
  }
  assert.ok(!pkg.scripts['test:content-aware-fill-smoke'],
    'UI fill smoke must not be an npm script');
  assert.ok(!pkg.scripts['test:content-aware-ui-smoke'],
    'UI fill smoke must not be an npm script');
  assert.ok(!/model:verify|content-aware-model-smoke/.test(JSON.stringify(pkg.scripts)),
    'model tooling must be gone');
}

console.log('content-aware fill removal contract tests passed');
