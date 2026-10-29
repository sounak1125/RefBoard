'use strict';
/* LaMa runtime spike: runs Carve's 512x512 LaMa export inside Electron and
 * reports model load time, time per fill, peak memory, and how far each
 * runtime's output is from the Python run that produced the bake-off.
 *
 *   npx electron scripts/inpaint-spike/lama-runtime-spike.cjs [--lab=<dir>] [--only=node,web-webgpu] [--runs=5] [--opt=all|extended|basic|disabled]
 *
 * Variants:
 *   node-cpu          onnxruntime-node in the main process, CPU
 *   node-dml          onnxruntime-node in the main process, DirectML (GPU)
 *   web-webgpu        onnxruntime-web in a renderer worker, WebGPU (cross-origin isolated page)
 *   web-webgpu-file   the same, from a plain file:// page loaded the way index.html is
 *   web-wasm-threads  onnxruntime-web WASM, multi-threaded (needs cross-origin isolation)
 *   web-wasm-1thread  onnxruntime-web WASM in a page without isolation, as index.html is today
 * --opt sets ONNX Runtime's graph optimisation level; it is most of the load time.
 *
 * Inputs are the tensors dump-tensors.py wrote to <lab>/spike. Runs under its
 * own app name, so RefBoard's settings and boards are never touched.
 */
const { app, BrowserWindow, protocol, net, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO = path.resolve(__dirname, '..', '..');
const arg = name => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const LAB = path.resolve(arg('lab') || path.join(REPO, 'inpaint-lab'));
const MODEL = path.join(LAB, 'models', 'lama-carve', 'lama_fp32.onnx');
const TENSORS = path.join(LAB, 'spike');
const RUNS = Number(arg('runs') || 5);
const OPT = arg('opt') || 'all';
const ONLY = arg('only');
const CASES = fs.readdirSync(TENSORS).filter(f => /^c\d+.*\.json$/.test(f)).map(f => f.slice(0, -5)).sort();
const VARIANTS = ['node-cpu', 'node-dml', 'web-webgpu', 'web-webgpu-file', 'web-wasm-threads', 'web-wasm-1thread']
  .filter(v => !ONLY || ONLY.split(',').some(o => v.startsWith(o)));
const MIME = {
  '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm',
  '.json': 'application/json', '.onnx': 'application/octet-stream', '.f32': 'application/octet-stream',
};

app.setName('RefBoard LaMa spike');
if (process.argv.includes('--unsafe-webgpu')) app.commandLine.appendSwitch('enable-unsafe-webgpu');
protocol.registerSchemesAsPrivileged([{
  scheme: 'spike',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const log = (...a) => console.log(...a);
const served = new Set();

/* spike://<mode>/repo/... and spike://<mode>/lab/... map onto the repo and the
 * lab folder. The `iso` host adds the headers that make a page cross-origin
 * isolated (SharedArrayBuffer, so WASM threads); `plain` leaves them off. */
function serve() {
  protocol.handle('spike', async request => {
    const url = new URL(request.url);
    const [root, ...rest] = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    const base = root === 'repo' ? REPO : root === 'lab' ? LAB : null;
    const file = base ? path.resolve(base, ...rest) : null;
    if (!file || !file.startsWith(base) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    served.add(path.relative(base, file).replace(/\\/g, '/'));
    const res = await net.fetch(pathToFileURL(file).href);
    const headers = new Headers({ 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    if (url.host === 'iso') {
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    }
    return new Response(res.body, { status: 200, headers });
  });
}

/* Peak working set per process type while a variant runs, in MB. */
function sampler() {
  const peak = {};
  const tick = () => {
    for (const m of app.getAppMetrics()) {
      peak[m.type] = Math.max(peak[m.type] || 0, (m.memory.workingSetSize || 0) / 1024);
    }
  };
  tick();
  const handle = setInterval(tick, 100);
  return {
    stop() {
      clearInterval(handle);
      tick();
      return Object.fromEntries(Object.entries(peak).map(([k, v]) => [k, Math.round(v)]));
    },
  };
}

function readF32(name) {
  const b = fs.readFileSync(path.join(TENSORS, name));
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

function compare(out, ref) {
  let max = 0, sum = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(out[i] - ref[i]);
    if (d > max) max = d;
    sum += d;
  }
  return { maxDiff: +max.toFixed(3), meanDiff: +(sum / ref.length).toFixed(4) };
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

async function runNode(ep) {
  const variant = `node-${ep}`;
  const ort = require('onnxruntime-node');
  const mem = sampler();
  const options = ep === 'dml'
    ? { executionProviders: ['dml'], enableMemPattern: false, executionMode: 'sequential' }
    : { executionProviders: ['cpu'] };
  let session;
  const t0 = performance.now();
  try {
    session = await ort.InferenceSession.create(MODEL, { ...options, graphOptimizationLevel: OPT });
  } catch (err) {
    return { variant, error: String(err && err.message || err), memoryMB: mem.stop() };
  }
  const result = { variant, loadMs: Math.round(performance.now() - t0), cases: [] };
  for (const id of CASES) {
    const feeds = {
      image: new ort.Tensor('float32', readF32(`${id}.image.f32`), [1, 3, 512, 512]),
      mask: new ort.Tensor('float32', readF32(`${id}.mask.f32`), [1, 1, 512, 512]),
    };
    try {
      const times = [];
      let out;
      for (let r = 0; r <= RUNS; r++) {
        const t = performance.now();
        out = (await session.run(feeds)).output.data;
        times.push(performance.now() - t);
      }
      result.cases.push({ case: id, firstMs: Math.round(times[0]), medianMs: median(times.slice(1)), ...compare(out, readF32(`${id}.ref.f32`)) });
    } catch (err) {
      result.cases.push({ case: id, error: String(err && err.message || err).split('\n')[0] });
    }
  }
  if (result.cases.every(c => c.error)) result.error = result.cases[0].error;
  await session.release();
  result.memoryMB = mem.stop();
  return result;
}

function runWeb(variant) {
  return new Promise(resolve => {
    const host = variant === 'web-wasm-1thread' ? 'plain' : 'iso';
    const runs = variant.startsWith('web-webgpu') ? RUNS : 2;
    const win = new BrowserWindow({
      show: false,
      webPreferences: { preload: path.join(__dirname, 'runtime-preload.cjs'), backgroundThrottling: false },
    });
    const mem = sampler();
    const finish = result => {
      clearTimeout(timer);
      ipcMain.off('spike-report', onReport);
      result.memoryMB = mem.stop();
      win.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ variant, error: 'timed out after 20 minutes' }), 20 * 60_000);
    const onReport = (event, result) => { if (event.sender === win.webContents) finish(result); };
    ipcMain.on('spike-report', onReport);
    win.webContents.on('console-message', e => log(`  [${variant}] ${e.message}`));
    win.webContents.on('render-process-gone', (e, details) => finish({ variant, error: `renderer gone: ${details.reason}` }));
    const query = { variant, cases: CASES.join(','), runs: String(runs), opt: OPT };
    if (variant.endsWith('-file')) {
      win.loadFile(path.join(__dirname, 'runtime-page.html'), { query: { ...query, labBase: pathToFileURL(LAB + path.sep).href } });
    } else {
      win.loadURL(`spike://${host}/repo/scripts/inpaint-spike/runtime-page.html?${new URLSearchParams(query)}`);
    }
  });
}

function printTable(results) {
  log('\nvariant            load    first   median  max diff  peak memory (MB)');
  for (const r of results) {
    const ok = (r.cases || []).filter(c => !c.error);
    if (r.error || !ok.length) { log(`${r.variant.padEnd(18)} ERROR ${String(r.error || r.cases[0].error).split('\n')[0].slice(0, 120)}`); continue; }
    const first = median(ok.map(c => c.firstMs));
    const med = median(ok.map(c => c.medianMs));
    const diff = Math.max(...ok.map(c => c.maxDiff));
    const mem = Object.entries(r.memoryMB || {}).map(([k, v]) => `${k} ${v}`).join(', ');
    log(`${r.variant.padEnd(18)} ${String(r.loadMs).padStart(6)}ms ${String(first).padStart(6)}ms ${String(med).padStart(6)}ms ${String(diff).padStart(8)}  ${mem}`);
  }
}

app.on('window-all-closed', () => { /* keep running between variants */ });

app.whenReady().then(async () => {
  serve();
  log(`Electron ${process.versions.electron}, Chrome ${process.versions.chrome}; cases: ${CASES.join(', ')}; runs: ${RUNS}`);
  const results = [];
  for (const variant of VARIANTS) {
    log(`--- ${variant}`);
    let r;
    try {
      r = variant.startsWith('node-') ? await runNode(variant.slice(5)) : await runWeb(variant);
    } catch (err) {
      r = { variant, error: String(err && err.message || err) };
    }
    log(JSON.stringify(r));
    results.push(r);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(TENSORS, `results-${stamp}.json`), JSON.stringify({
    when: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    opt: OPT,
    served: [...served].filter(f => /onnxruntime-web/.test(f)),
    results,
  }, null, 2));
  printTable(results);
  app.quit();
});
