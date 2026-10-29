// One onnxruntime-web variant: load the model, time each case, compare the
// output with the Python run, post the result. See lama-runtime-spike.cjs.
const log = text => postMessage({ type: 'log', text });
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => { log(`${level}: ${args.map(String).join(' ')}`); original(...args); };
}

// The lab is served at /lab/ on the spike protocol; a file:// page passes its own base.
let labBase = new URL('/lab/', import.meta.url);
const lab = p => new URL(p, labBase);
const bytes = async p => {
  const res = await fetch(lab(p));
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};
const f32 = async p => new Float32Array((await bytes(p)).buffer);
const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

onmessage = async ({ data }) => {
  const { variant, cases, runs, opt = 'all' } = data;
  if (data.labBase) labBase = new URL(data.labBase);
  const result = { variant, cases: [], hardwareConcurrency: navigator.hardwareConcurrency, workerCrossOriginIsolated: self.crossOriginIsolated };
  try {
    const dist = new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url).href;
    const webgpu = variant.startsWith('web-webgpu');
    const ort = await import(`${dist}${webgpu ? 'ort.webgpu.min.mjs' : 'ort.wasm.min.mjs'}`);
    ort.env.wasm.wasmPaths = dist;
    ort.env.logLevel = 'warning';
    if (webgpu) {
      if (!navigator.gpu) throw new Error('navigator.gpu is missing');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('no WebGPU adapter');
      const info = adapter.info || {};
      result.adapter = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'unknown';
    }
    let t = performance.now();
    const model = await bytes('models/lama-carve/lama_fp32.onnx');
    result.fetchMs = Math.round(performance.now() - t);
    t = performance.now();
    const session = await ort.InferenceSession.create(model, {
      executionProviders: [webgpu ? 'webgpu' : 'wasm'],
      graphOptimizationLevel: opt,
    });
    result.loadMs = Math.round(performance.now() - t);
    result.numThreads = ort.env.wasm.numThreads;
    for (const id of cases.split(',')) {
      const feeds = {
        image: new ort.Tensor('float32', await f32(`spike/${id}.image.f32`), [1, 3, 512, 512]),
        mask: new ort.Tensor('float32', await f32(`spike/${id}.mask.f32`), [1, 1, 512, 512]),
      };
      const ref = await f32(`spike/${id}.ref.f32`);
      const times = [];
      let out;
      for (let r = 0; r <= Number(runs); r++) {
        const t0 = performance.now();
        const res = await session.run(feeds);
        out = res.output.data ?? await res.output.getData();
        times.push(performance.now() - t0);
      }
      let max = 0, sum = 0;
      for (let i = 0; i < ref.length; i++) {
        const d = Math.abs(out[i] - ref[i]);
        if (d > max) max = d;
        sum += d;
      }
      result.cases.push({
        case: id, firstMs: Math.round(times[0]), medianMs: median(times.slice(1)),
        maxDiff: +max.toFixed(3), meanDiff: +(sum / ref.length).toFixed(4),
      });
      log(`${id}: first ${Math.round(times[0])}ms, then ${times.slice(1).map(Math.round).join('/')}ms`);
    }
    await session.release();
  } catch (err) {
    result.error = String(err && (err.stack || err.message) || err);
  }
  postMessage({ type: 'done', result });
};
