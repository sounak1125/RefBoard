/* Mask preprocessing (§25) and algorithm classification (§5). */
import assert from 'node:assert/strict';
import { loadEngine, rectMask, scratchMask, countMask } from './content-aware-harness.mjs';

const CAF = await loadEngine();
const { maskProcessor } = CAF;
const W = 80, H = 60;

/* --- normalisation ------------------------------------------------------ */
{
  const binary = rectMask(W, H, 10, 10, 8, 8);
  const soft = maskProcessor.normalize(binary, W, H);
  assert.equal(soft.length, W * H, 'single-channel masks keep their length');
  assert.equal(soft[10 * W + 10], 255, '1 is promoted to fully opaque');
  assert.equal(soft[0], 0, 'zero stays zero');

  const ramp = new Uint8Array(W * H);
  ramp[5] = 200; ramp[6] = 20;
  const softRamp = maskProcessor.normalize(ramp, W, H);
  assert.equal(softRamp[5], 200, 'intermediate values survive for feathered edges');
  assert.equal(softRamp[6], 20);

  const rgba = new Uint8ClampedArray(W * H * 4);
  rgba[(12 * W + 12) * 4] = 255;
  const softRgba = maskProcessor.normalize(rgba, W, H);
  assert.equal(softRgba[12 * W + 12], 255, 'an RGBA mask reads its red channel');

  assert.throws(() => maskProcessor.normalize(new Uint8Array(7), W, H), /matches neither/,
    'a mask of the wrong length must fail loudly rather than be guessed at');
}

/* --- mask inversion ------------------------------------------------------
 * The single most damaging class of bug in this area: filling everything
 * except the selection. Assert the sense of the mask explicitly. */
{
  const mask = rectMask(W, H, 30, 20, 10, 10);
  const info = maskProcessor.prepare(mask, W, H, { maskExpansion: 0, despeckle: false });
  assert.equal(info.fill[25 * W + 35], 1, 'a selected pixel is marked for reconstruction');
  assert.equal(info.fill[5 * W + 5], 0, 'an unselected pixel is not');
  assert.equal(countMask(info.fill), 100, 'exactly the selected pixels are filled');
}

/* --- connected components and despeckling ------------------------------- */
{
  const mask = rectMask(W, H, 20, 20, 20, 20);
  mask[2 * W + 2] = 1;                    // a stray click, far from the real mask
  const comps = maskProcessor.connectedComponents(mask, W, H);
  assert.equal(comps.count, 2, 'the speck is its own component');

  const cleaned = maskProcessor.despeckle(mask, W, H);
  assert.equal(cleaned.removed, 1, 'the speck is dropped');
  assert.equal(cleaned.mask[2 * W + 2], 0);
  assert.equal(cleaned.mask[25 * W + 25], 1, 'the real selection survives');

  // A deliberately tiny mask is not a speck; there is nothing to compare it to.
  const tiny = rectMask(W, H, 10, 10, 2, 2);
  const keptTiny = maskProcessor.despeckle(tiny, W, H);
  assert.equal(countMask(keptTiny.mask), 4, 'a mask made only of small parts is left alone');
}

/* --- expansion (§25) ----------------------------------------------------- */
{
  const mask = rectMask(W, H, 30, 20, 10, 10);
  const plain = maskProcessor.prepare(mask, W, H, { maskExpansion: 0 });
  const grown = maskProcessor.prepare(mask, W, H, { maskExpansion: 3 });
  assert.ok(countMask(grown.fill) > countMask(plain.fill), 'expansion grows the region');
  assert.equal(grown.expansion, 3, 'the expansion actually applied is reported');
  assert.equal(grown.fill[20 * W + 35], 1, 'the grown region reaches above the original edge');
  for (let i = 0; i < W * H; i++) {
    if (plain.fill[i]) assert.equal(grown.fill[i], 1, 'expansion only ever adds');
  }
}

/* --- classification (§5) -------------------------------------------------
 * The test is the hole's thickest point, not its area: a scratch spanning the
 * whole frame is still a scratch. */
{
  const scratch = scratchMask(W, H, 5, 5, 70, 50, 3);
  const thin = maskProcessor.prepare(scratch, W, H, { maskExpansion: 0 });
  assert.equal(thin.algorithm, 'telea', 'a thin scratch goes to diffusion inpainting');
  assert.ok(thin.maxDepth <= maskProcessor.THIN_DEPTH);

  const blob = rectMask(W, H, 25, 20, 22, 20);
  const large = maskProcessor.prepare(blob, W, H, { maskExpansion: 0 });
  assert.equal(large.algorithm, 'patchmatch', 'a solid region goes to exemplar synthesis');
  assert.ok(large.maxDepth > maskProcessor.THIN_DEPTH);

  const dust = rectMask(W, H, 40, 40, 2, 2);
  assert.equal(maskProcessor.prepare(dust, W, H, { maskExpansion: 0 }).algorithm, 'telea',
    'dust specks go to diffusion inpainting');
}

/* --- empty masks --------------------------------------------------------- */
{
  assert.throws(() => maskProcessor.prepare(new Uint8Array(W * H), W, H, {}), /empty/,
    'an empty mask is an error, not a silent no-op');
}

/* --- bounds -------------------------------------------------------------- */
{
  const mask = rectMask(W, H, 30, 20, 10, 8);
  const info = maskProcessor.prepare(mask, W, H, { maskExpansion: 0 });
  assert.deepEqual(
    { x0: info.bounds.x0, y0: info.bounds.y0, width: info.bounds.width, height: info.bounds.height },
    { x0: 30, y0: 20, width: 10, height: 8 }, 'bounds are exact and half-open');
}

console.log('content-aware mask preprocessing tests passed');
