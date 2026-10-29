/**
 * Content-aware fill wiring, read from the sources.
 *
 * The parts that fail silently are the joins: the installer must carry exactly
 * the onnxruntime-web files the worker asks for (and not the other 110 MB of
 * that package), the worker must be packaged, the preview must never leak into
 * an export, and Apply must go through the same undoable pixel-edit path as the
 * draw tool. smoke-inpaint-fill.mjs runs the real thing; this pins the joins so
 * a refactor cannot quietly undo one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Line endings depend on the checkout; the patterns below are written with \n.
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const html = read('index.html');
const main = read('main.js');
const preload = read('preload.js');
const worker = read('scripts/inpaint-worker.mjs');
const pkg = JSON.parse(read('package.json'));

// --- packaging -------------------------------------------------------------
for (const file of ['scripts/inpaint-model.js', 'scripts/inpaint-geometry.mjs', 'scripts/inpaint-worker.mjs']) {
  assert.ok(pkg.build.files.includes(file), `build.files must package ${file}`);
}
assert.ok(pkg.devDependencies['onnxruntime-web'], 'onnxruntime-web is a devDependency');
assert.ok(!pkg.dependencies['onnxruntime-web'],
  'onnxruntime-web must not be a dependency: electron-builder would pack all 140 MB of its dist into the asar');
assert.ok(!pkg.dependencies['onnxruntime-node'], 'onnxruntime-node is only for the runtime spike');

// The runtime ships as extraResources, and as exactly what the worker loads.
const runtime = pkg.build.extraResources.filter(r => String(r.to).startsWith('onnxruntime-web/'));
const runtimeNames = runtime.map(r => path.basename(r.to)).sort();
assert.deepEqual(runtimeNames, [
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
  'ort.webgpu.min.mjs',
]);
for (const r of runtime) {
  assert.equal(path.basename(r.from), path.basename(r.to), `${r.from} keeps its name`);
  assert.ok(fs.existsSync(path.join(ROOT, r.from)), `${r.from} must exist when building`);
}
assert.match(worker, /import\(`\$\{runtimeUrl\}ort\.webgpu\.min\.mjs`\)/, 'the worker loads ort.webgpu.min.mjs from the runtime folder');
assert.match(worker, /ort\.env\.wasm\.wasmPaths = runtimeUrl/, 'and points onnxruntime at the same folder for its WASM');
const ortBundle = read('node_modules/onnxruntime-web/dist/ort.webgpu.min.mjs');
assert.match(ortBundle, /ort-wasm-simd-threaded\.asyncify/,
  'ort.webgpu.min.mjs must still load the asyncify build; if onnxruntime changed builds, extraResources must follow');
assert.match(main, /path\.join\(process\.resourcesPath, 'onnxruntime-web'\)/, 'an installed app reads the runtime from resources/onnxruntime-web');
assert.match(main, /path\.join\(__dirname, 'node_modules', 'onnxruntime-web', 'dist'\)/, 'a dev run reads it from node_modules');

// The bake-off's model copy is a dev convenience only, never looked for in an installed app.
assert.match(main, /app\.isPackaged \? \[\] : \[path\.join\(__dirname, 'inpaint-lab'/);
assert.match(read('.gitignore'), /^inpaint-lab\/$/m, 'inpaint-lab holds private board images and must stay ignored');

// --- IPC ---------------------------------------------------------------------
for (const channel of ['inpaint-model-status', 'inpaint-model-download', 'inpaint-model-cancel']) {
  assert.match(main, new RegExp(`ipcMain\\.handle\\('${channel}'`), `main handles ${channel}`);
  assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\('${channel}'`), `preload exposes ${channel}`);
}
assert.match(preload, /ipcRenderer\.on\('inpaint-model-progress'/);
assert.match(main, /net\.fetch\(url, init\)/, 'the download goes through Electron net (system proxy, redirects)');

// --- worker ------------------------------------------------------------------
assert.match(worker, /executionProviders: \['webgpu'\]/, 'v1 runs on WebGPU only');
assert.match(worker, /postMessage\(\{ type: 'filled', id, bitmap, runMs \}, \[bitmap\]\)/, 'results come back with their request id, transferred');
assert.match(html, /new Worker\('\.\/scripts\/inpaint-worker\.mjs', \{ type: 'module' \}\)/);
assert.match(html, /from '\.\/scripts\/inpaint-geometry\.mjs'/);

// --- UI ----------------------------------------------------------------------
assert.match(html, /<button class="tb sel-one-image-only" id="sFill"/, 'the selection bar offers the tool for one image');
assert.match(html, /#selbar:not\(\.one-image\) \.sel-one-image-only\{ display:none; \}/);
assert.match(html, /bar\.classList\.toggle\('one-image', n === 1 && selectedImages\(\)\.length === 1\)/);
for (const id of ['fillBar', 'fillStatus', 'fillCancel', 'fillApply']) {
  assert.match(html, new RegExp(`id="${id}"`), `#${id} exists`);
}
assert.match(html, /\{ l: 'Remove object…', f: \(\) => void startFill\(selItems\[0\]\) \}/, 'the image context menu offers it too');

// The preview replaces the item's surface on the board only: exports pick their own surfaces.
assert.match(html, /fillSession\?\.itemId === it\.id && fillSession\.work && !opts\.pickSurface/);

// Apply is the draw tool's path: private copy for duplicates, then one undo entry with the old bytes.
const apply = html.slice(html.indexOf('async function applyFill()'), html.indexOf('function endFill()'));
assert.match(apply, /prepareExclusiveImageEdit\(it\)/);
assert.match(apply, /if \(prepared\.detached\) it\.imgId = prepared\.detachedImgId;\s*pushUndo\(\{ imgId: it\.imgId, blob: undoBlob \}\);/);
assert.match(apply, /commitFillPixels\(prepared\.im, s\.work\)/);

// Keys inside the tool: Esc leaves, Enter applies, Ctrl+Z steps back one fill rather than board history.
const keys = html.slice(html.indexOf('  if (fillSession) {\n    if (k === \'escape\')'), html.indexOf('  if (k === \'escape\') {\n    if (noteEditId)'));
assert.ok(keys.length > 0, 'the fill tool handles its keys before the board does');
assert.match(keys, /cancelFill\(\)/);
assert.match(keys, /applyFill\(\)/);
assert.match(keys, /stepBackFill\(\)/);

// Every other tool hands over by ending the fill.
for (const fn of ['function setDrawActive(on)', 'function setArrowTool(style)', 'function enterCropMode(it)', 'async function applyUndoEntry(entry, direction)']) {
  const start = html.indexOf(fn);
  assert.ok(start >= 0, `${fn} exists`);
  assert.match(html.slice(start, start + 900), /cancelFill\(\)/, `${fn} ends an open fill`);
}

console.log('inpaint contract ok');
