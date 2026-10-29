/* Content-aware fill worker: LaMa (Carve's 512x512 ONNX export) on WebGPU.
 *
 * The page sends the region it wants filled and a mask of the hole, both as
 * ImageBitmaps at source resolution (the region comes from cropRegion in
 * inpaint-geometry.mjs). The worker mirrors the region out to a square when
 * the image was too small to fill one, scales it to the model's 512 px, runs
 * the model, scales the answer back up, and returns the region with only the
 * masked pixels replaced, feathered by the mask's own antialiasing. Everything
 * outside the mask comes back exactly as it went in.
 *
 *   in:  { type: 'load', runtimeUrl, modelUrl }
 *        { type: 'fill', id, crop: ImageBitmap, mask: ImageBitmap }
 *        { type: 'release' }
 *   out: { type: 'loaded', id, loadMs } | { type: 'filled', id, bitmap, runMs }
 *        { type: 'released', id } | { type: 'error', id, message }
 * Every reply carries the id of the request it answers.
 */
import { INPAINT_INPUT } from './inpaint-geometry.mjs';

const S = INPAINT_INPUT;
let ort = null;
let session = null;
let loading = null;

function load(runtimeUrl, modelUrl) {
  if (!loading) {
    loading = (async () => {
      const started = performance.now();
      if (!navigator.gpu || !(await navigator.gpu.requestAdapter())) {
        throw new Error('This computer has no WebGPU graphics adapter');
      }
      ort = await import(`${runtimeUrl}ort.webgpu.min.mjs`);
      ort.env.wasm.wasmPaths = runtimeUrl;
      ort.env.logLevel = 'error';
      const res = await fetch(modelUrl);
      if (!res.ok) throw new Error(`The model could not be read (${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      session = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
      return Math.round(performance.now() - started);
    })();
    // A failed load can be retried; a successful one is reused.
    loading.catch(() => { loading = null; });
  }
  return loading;
}

const context = (w, h) => new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });

/* The region at the top-left of a side x side square, the rest mirrored the
   way the bake-off's reflect padding did. Only an image smaller than the
   square in some direction needs any of it. */
function squareOf(bitmap, side) {
  const g = context(side, side);
  const { width: w, height: h } = bitmap;
  for (let ty = 0; ty * h < side; ty++) {
    for (let tx = 0; tx * w < side; tx++) {
      g.save();
      g.translate(tx * w + (tx % 2 ? w : 0), ty * h + (ty % 2 ? h : 0));
      g.scale(tx % 2 ? -1 : 1, ty % 2 ? -1 : 1);
      g.drawImage(bitmap, 0, 0);
      g.restore();
    }
  }
  return g.canvas;
}

function scaledTo(source, w, h) {
  const g = context(w, h);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(source, 0, 0, w, h);
  return g;
}

async function fill(crop, mask) {
  const w = crop.width, h = crop.height;
  const side = Math.max(w, h);

  // The model's input: the region as a 512 square, and the hole (any coverage at 512 counts).
  const pixels = scaledTo(squareOf(crop, side), S, S).getImageData(0, 0, S, S).data;
  const holeSquare = context(side, side);
  holeSquare.drawImage(mask, 0, 0);
  const hole = scaledTo(holeSquare.canvas, S, S).getImageData(0, 0, S, S).data;
  const plane = S * S;
  const image = new Float32Array(3 * plane);
  const holeMask = new Float32Array(plane);
  for (let i = 0; i < plane; i++) {
    image[i] = pixels[i * 4] / 255;
    image[plane + i] = pixels[i * 4 + 1] / 255;
    image[2 * plane + i] = pixels[i * 4 + 2] / 255;
    holeMask[i] = hole[i * 4 + 3] > 0 ? 1 : 0;
  }

  const started = performance.now();
  const result = await session.run({
    image: new ort.Tensor('float32', image, [1, 3, S, S]),
    mask: new ort.Tensor('float32', holeMask, [1, 1, S, S]),
  });
  const runMs = Math.round(performance.now() - started);
  const out = result.output.data;
  result.output.dispose?.();

  // The answer, 0-255 per channel, back up to the region's own size.
  const answer = new ImageData(S, S);
  for (let i = 0; i < plane; i++) {
    answer.data[i * 4] = out[i];
    answer.data[i * 4 + 1] = out[plane + i];
    answer.data[i * 4 + 2] = out[2 * plane + i];
    answer.data[i * 4 + 3] = 255;
  }
  const small = context(S, S);
  small.putImageData(answer, 0, 0);
  const predicted = context(w, h);
  predicted.imageSmoothingEnabled = true;
  predicted.imageSmoothingQuality = 'high';
  predicted.drawImage(small.canvas, 0, 0, side, side);
  const pred = predicted.getImageData(0, 0, w, h).data;

  // Only masked pixels change; the mask's antialiased edge feathers by one pixel.
  const original = context(w, h);
  original.drawImage(crop, 0, 0);
  const merged = original.getImageData(0, 0, w, h);
  const px = merged.data;
  const edge = context(w, h);
  edge.drawImage(mask, 0, 0);
  const alpha = edge.getImageData(0, 0, w, h).data;
  for (let i = 3; i < px.length; i += 4) {
    const a = alpha[i];
    if (!a) continue;
    const k = a / 255;
    px[i - 3] += (pred[i - 3] - px[i - 3]) * k;
    px[i - 2] += (pred[i - 2] - px[i - 2]) * k;
    px[i - 1] += (pred[i - 1] - px[i - 1]) * k;
  }
  original.putImageData(merged, 0, 0);
  return { bitmap: original.canvas.transferToImageBitmap(), runMs };
}

onmessage = async ({ data }) => {
  const { type, id } = data || {};
  try {
    if (type === 'load') {
      postMessage({ type: 'loaded', id, loadMs: await load(data.runtimeUrl, data.modelUrl) });
    } else if (type === 'fill') {
      if (!session) throw new Error('The model is not loaded');
      const { bitmap, runMs } = await fill(data.crop, data.mask);
      data.crop.close();
      data.mask.close();
      postMessage({ type: 'filled', id, bitmap, runMs }, [bitmap]);
    } else if (type === 'release') {
      await session?.release();
      session = null;
      loading = null;
      postMessage({ type: 'released', id });
    }
  } catch (err) {
    postMessage({ type: 'error', id, message: String(err?.message || err) });
  }
};
