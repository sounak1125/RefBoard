/* Regression tests (§39).
 *
 * One case per failure mode §39 names: black output, transparent output,
 * crashes, out-of-bounds patches, mask inversion, alpha corruption, visible
 * seams, repeated blocks, and memory blow-ups. Each asserts the *symptom* is
 * absent, so a reintroduced bug fails here rather than in a screenshot.
 */
import assert from 'node:assert/strict';
import {
  loadEngine, grassScene, wallScene, skyScene, horizonScene, blankImage,
  ellipseMask, rectMask, scratchMask, countMask, meanColor, textureEnergy,
  makeRandom,
} from './content-aware-harness.mjs';

const CAF = await loadEngine();
const W = 150, H = 110;

const fill = (scene, mask, options) => CAF.fill(
  { data: new Uint8ClampedArray(scene.data), width: scene.width, height: scene.height },
  mask, (options && options.samplingMask) || null,
  Object.assign({ seed: 1337, maskExpansion: 0 }, options));

/* --- black output -------------------------------------------------------- */
{
  const scene = wallScene(W, H);
  const mask = ellipseMask(W, H, 75, 55, 20, 16);
  const r = fill(scene, mask);
  const [mr, mg, mb] = meanColor(r.pixels, W, H, mask);
  assert.ok(mr > 20 && mg > 20 && mb > 20,
    `the fill must not be black (mean ${mr.toFixed(0)},${mg.toFixed(0)},${mb.toFixed(0)})`);
  const expected = meanColor(scene.data, W, H, CAF.dilateMask(mask, W, H, 6));
  assert.ok(Math.abs(mr - expected[0]) < 60, 'and must sit near the surrounding tone');
}

/* --- transparent output -------------------------------------------------- */
{
  const scene = grassScene(W, H);
  const mask = ellipseMask(W, H, 75, 55, 18, 15);
  const r = fill(scene, mask);
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    assert.equal(r.pixels[i * 4 + 3], 255, 'no reconstructed pixel may end up transparent');
  }
}

/* --- alpha corruption outside the fill ----------------------------------- */
{
  const scene = grassScene(W, H);
  for (let i = 0; i < W * H; i++) scene.data[i * 4 + 3] = 200;   // uniformly semi-transparent
  const mask = ellipseMask(W, H, 75, 55, 16, 13);
  const r = fill(scene, mask);
  for (let i = 0; i < W * H; i++) {
    if (mask[i]) continue;
    assert.equal(r.pixels[i * 4 + 3], 200, 'alpha outside the fill is never rewritten');
  }
}

/* --- mask inversion ------------------------------------------------------ */
{
  const scene = wallScene(W, H);
  const mask = rectMask(W, H, 20, 15, 14, 12);
  const input = new Uint8ClampedArray(scene.data);
  const r = fill(scene, mask);
  let changedInside = 0, changedOutside = 0;
  for (let i = 0; i < W * H; i++) {
    let differs = false;
    for (let c = 0; c < 3; c++) if (r.pixels[i * 4 + c] !== input[i * 4 + c]) differs = true;
    if (!differs) continue;
    if (mask[i]) changedInside++; else changedOutside++;
  }
  assert.equal(changedOutside, 0, 'nothing outside the selection may change');
  assert.ok(changedInside > 0, 'and the selection itself must actually change');
}

/* --- out-of-bounds patches: a mask hard against every edge --------------- */
{
  for (const mask of [
    rectMask(W, H, 0, 0, 22, 18),                 // top-left corner
    rectMask(W, H, W - 22, 0, 22, 18),            // top-right
    rectMask(W, H, 0, H - 18, 22, 18),            // bottom-left
    rectMask(W, H, W - 22, H - 18, 22, 18),       // bottom-right
    rectMask(W, H, 0, 40, 18, 22),                // full-height contact, left edge
  ]) {
    const scene = grassScene(W, H);
    const r = fill(scene, mask);
    for (let i = 0; i < W * H; i++) {
      if (!mask[i]) continue;
      for (let c = 0; c < 4; c++) {
        assert.ok(Number.isFinite(r.pixels[i * 4 + c]), 'no NaN reaches the output');
      }
    }
    assert.ok(r.metrics.missingRatio < 0.02, 'a mask touching an edge is still fully covered');
  }
}

/* --- NaN patch costs ----------------------------------------------------- */
{
  const scene = wallScene(W, H);
  const mask = ellipseMask(W, H, 75, 55, 18, 15);
  const r = fill(scene, mask);
  for (const [key, value] of Object.entries(r.metrics)) {
    if (typeof value !== 'number') continue;
    assert.ok(Number.isFinite(value), `metric ${key} must be finite, got ${value}`);
  }
  assert.ok(Number.isFinite(r.confidence) && r.confidence >= 0 && r.confidence <= 1,
    'confidence stays a probability');
}

/* --- zero-weight voting: a flat image gives every patch an identical cost - */
{
  const flat = blankImage(W, H, [128, 128, 128, 255]);
  const mask = ellipseMask(W, H, 75, 55, 18, 15);
  const r = fill(flat, mask);
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    assert.equal(r.pixels[i * 4], 128, 'a flat image reconstructs to the same flat value');
  }
}

/* --- repeated blocks ----------------------------------------------------- */
{
  const scene = grassScene(W, H);
  const mask = ellipseMask(W, H, 75, 55, 24, 20);
  const r = fill(scene, mask);
  assert.ok(r.metrics.repeatedPatchDensity < 0.9,
    `the same few patches must not be reused everywhere (${r.metrics.repeatedPatchDensity.toFixed(2)})`);
}

/* --- a hole occupying most of the frame does not crash ------------------- */
{
  const scene = grassScene(W, H);
  const mask = rectMask(W, H, 12, 10, W - 24, H - 20);
  const r = fill(scene, mask, { quality: 'preview' });
  assert.ok(r.pixels.length === W * H * 4, 'the engine completes');
  assert.ok(r.status === 'OK' || r.status === 'LOW_CONFIDENCE' || r.status === 'REJECTED',
    'and reports a status rather than pretending');
  const [mr] = meanColor(r.pixels, W, H, mask);
  assert.ok(mr > 5, 'the result is not black');
}

/* --- a 1px-wide mask, and a mask of a single pixel ---------------------- */
{
  const scene = wallScene(W, H);
  for (const mask of [rectMask(W, H, 70, 20, 1, 60), rectMask(W, H, 70, 55, 1, 1)]) {
    const r = fill(scene, mask);
    assert.equal(r.algorithmUsed, 'telea', 'degenerate masks take the diffusion path');
    for (let i = 0; i < W * H; i++) {
      if (!mask[i]) continue;
      assert.ok(Number.isFinite(r.pixels[i * 4]), 'and produce finite pixels');
    }
  }
}

/* --- a scratch is repaired, not merely blurred -------------------------- */
{
  const scene = wallScene(W, H);
  const mask = scratchMask(W, H, 20, 20, 120, 80, 3);
  const input = new Uint8ClampedArray(scene.data);
  // Draw the scratch in as a bright line, so a no-op is detectable.
  for (let i = 0; i < W * H; i++) {
    if (!mask[i]) continue;
    scene.data[i * 4] = 255; scene.data[i * 4 + 1] = 255; scene.data[i * 4 + 2] = 255;
  }
  const r = fill(scene, mask);
  assert.equal(r.algorithmUsed, 'telea');
  let white = 0;
  for (let i = 0; i < W * H; i++) if (mask[i] && r.pixels[i * 4] > 240) white++;
  assert.equal(white, 0, 'the scratch is gone');
  const [mr] = meanColor(r.pixels, W, H, mask);
  const [er] = meanColor(input, W, H, mask);
  assert.ok(Math.abs(mr - er) < 25, `and the repair matches the wall (${mr.toFixed(0)} vs ${er.toFixed(0)})`);
}

/* --- cancellation leaves no partial commitment and frees promptly -------- */
{
  const scene = grassScene(W, H);
  const mask = ellipseMask(W, H, 75, 55, 20, 16);
  let calls = 0;
  assert.throws(
    () => CAF.fill({ data: new Uint8ClampedArray(scene.data), width: W, height: H }, mask, null,
      { seed: 1, isCancelled: () => ++calls > 3 }),
    err => err.name === 'Cancelled',
    'cancellation surfaces as a Cancelled error rather than a half-finished image');
}

/* --- a time budget expiring behaves exactly like cancellation ----------- */
{
  const scene = grassScene(W, H);
  const mask = ellipseMask(W, H, 75, 55, 20, 16);
  const deadline = Date.now() - 1;      // already expired
  assert.throws(
    () => CAF.fill({ data: new Uint8ClampedArray(scene.data), width: W, height: H }, mask, null,
      { seed: 1, isCancelled: () => Date.now() > deadline }),
    err => err.name === 'Cancelled');
}

/* --- malformed input is rejected with a real message -------------------- */
{
  assert.throws(() => CAF.fill({ data: new Uint8ClampedArray(10), width: W, height: H },
    rectMask(W, H, 1, 1, 4, 4), null, {}), /expected/, 'a short buffer is caught');
  assert.throws(() => CAF.fill({ data: new Uint8ClampedArray(W * H * 4), width: W, height: H },
    new Uint8Array(3), null, {}), /matches neither/, 'a wrong-sized mask is caught');
}

/* --- a very large selection stays inside the host's time budget ---------
 * Matching scales with the hole, so the presets' fixed refinement budgets stop
 * making sense at the top end: a 4.5-megapixel selection took 860s at Balanced,
 * past the budget the renderer allows, and was cancelled instead of finishing.
 * Past a threshold a preset drops one reconstruction pass and stops bumping the
 * patch size, which took the same fill to 220s at equal quality. */
{
  const px = new Uint8ClampedArray(64 * 64 * 4).fill(128);
  const resolve = (holeArea, quality) => CAF.resolveOptions({ quality }, {
    width: 6000, height: 4000, holeArea, pixels: px, textureFrequency: 6,
  });

  // Below the threshold, nothing changes: ordinary fills keep full quality.
  const ordinary = resolve(300000, 'balanced');
  assert.equal(ordinary.passes, 2, 'a normal selection keeps both reconstruction passes');

  const huge = resolve(4500000, 'balanced');
  assert.equal(huge.passes, 1, 'a very large selection drops to one pass');
  assert.ok(huge.patchSize <= 9,
    `and is not given the large-hole patch bump (got ${huge.patchSize})`);

  // The adaptation must not collapse the presets into each other.
  const hp = resolve(4500000, 'preview');
  const hb = resolve(4500000, 'balanced');
  const hh = resolve(4500000, 'high');
  assert.ok(hh.passes >= hb.passes && hb.passes >= hp.passes,
    'preset ordering by passes survives the adaptation');
  assert.ok(hh.iterations > hb.iterations && hb.iterations > hp.iterations,
    'and the presets remain distinguishable by iterations');
  assert.ok(hp.passes >= 1, 'passes never drops below one');

  // The threshold is a real boundary, not an accident of rounding.
  assert.equal(resolve(1400000, 'balanced').passes, 2, 'just below the threshold is unaffected');
  assert.equal(resolve(1600000, 'balanced').passes, 1, 'just above it adapts');
}

/* --- horizon: the fill must not import the wrong side ------------------- */
{
  const scene = horizonScene(W, H);
  // A hole entirely in the sky must come back as sky, not ground.
  const mask = ellipseMask(W, H, 75, 20, 16, 12);
  const r = fill(scene, mask);
  const [fr, fg, fb] = meanColor(r.pixels, W, H, mask);
  assert.ok(fb > fr, `sky stays blue-dominant (r ${fr.toFixed(0)} b ${fb.toFixed(0)})`);
}

/* --- image noise must not be scored as a bad fill ----------------------- */
{
  /* Patch cost is an absolute distance, so a grainy photograph pushes it up on
   * its own: the same fill that scored 0.21 clean scored 1.69 at +/-64, which
   * the raw thresholds read as "no good matches were found" and hard-rejected.
   * Normalising against the boundary's own adjacent-pixel step has to hold a
   * correct fill flat while leaving a genuinely wrong one detectable. */
  const grain = (scene, amount) => {
    if (!amount) return scene;
    const rnd = makeRandom(99);
    for (let i = 0; i < scene.width * scene.height; i++) {
      const n = (rnd() - 0.5) * 2 * amount;
      for (let c = 0; c < 3; c++) {
        scene.data[i * 4 + c] = Math.max(0, Math.min(255, scene.data[i * 4 + c] + n));
      }
    }
    return scene;
  };

  let sawRawCross = false;
  for (const amount of [0, 24, 48, 64]) {
    const scene = grain(grassScene(W, H), amount);
    const mask = ellipseMask(W, H, 75, 55, 20, 16);
    const r = fill(scene, mask);
    const m = r.metrics;
    if (m.patchCostMean > 0.6) sawRawCross = true;
    assert.ok(m.patchCostNormalized < 0.4,
      `grain +/-${amount} must not inflate patch cost (raw ${m.patchCostMean.toFixed(2)}, normalised ${m.patchCostNormalized.toFixed(2)})`);
    assert.ok(!r.unsafeReasons.includes('no good matches were found for this region'),
      `and must not be rejected for it (grain +/-${amount})`);
  }
  assert.ok(sawRawCross,
    'the sweep must actually reach the noise level the raw threshold used to fail at');

  // The same measure still catches a hole spliced in from an incompatible region.
  for (const amount of [0, 24]) {
    const scene = grain(horizonScene(W, H), amount);
    const mask = ellipseMask(W, H, 75, 80, 15, 11);
    const samplingMask = new Uint8Array(W * H);
    for (let y = 0; y < 40; y++) for (let x = 0; x < W; x++) samplingMask[y * W + x] = 255;
    const r = fill(scene, mask, { samplingMask });
    assert.ok(r.metrics.patchCostNormalized > 1.2,
      `ground filled from sky stays detectable at grain +/-${amount} (${r.metrics.patchCostNormalized.toFixed(2)})`);
    assert.ok(r.hardRejected, 'and is still rejected');
  }
}

console.log('content-aware regression tests passed');
