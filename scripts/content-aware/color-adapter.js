'use strict';
/* Colour adaptation (§19).
 *
 * Sometimes the right texture lives in a part of the image at a different
 * brightness — the same wall two metres further from the window. The patch is
 * correct, its exposure is not, and pasting it raw leaves a visible tile.
 *
 * §19 frames this as matching distributions: normalise the source by its own
 * mean and standard deviation, then rescale to the target's. What is implemented
 * here is the least-squares form of the same idea, fitted on the pixels where
 * source and target actually correspond rather than on two independent
 * histograms. It matters for the reason §19's own warning names — do not
 * over-normalise texture. A pure std-ratio gain rescales *contrast*, so a patch
 * of fine grain dropped next to a smooth region gets its grain stretched to
 * match the smooth region's variance. The regression gain cannot do that: with
 * uncorrelated source and target the covariance goes to zero and the gain
 * collapses toward the regularised value of 1, which is the safe answer.
 *
 * One shared gain across the three channels, with per-channel bias free. A
 * per-channel gain is a colour cast waiting to happen; a shared gain moves
 * exposure while leaving hue alone.
 *
 * Ported from the previous engine, whose tuning constants these are.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp } = CAF;

  const ADAPT_GAIN_MIN = 0.65;
  const ADAPT_GAIN_MAX = 1.55;
  const ADAPT_BIAS_MAX = 42;
  /* In variance units. A patch with little variance has nothing to fit a gain
   * to, so this pulls it to 1 instead of dividing by ~0. */
  const ADAPT_REG = 24;
  const ADAPT_MIN_KNOWN = 10;

  /* With per-channel bias free, the optimal shared gain falls out of the
   * channel-summed covariance over the channel-summed source variance; the
   * biases are then the mean offsets that remain. */
  function solveFit(n, sR, sG, sB, tR, tG, tB, ssR, ssG, ssB, stR, stG, stB, out) {
    if (n < ADAPT_MIN_KNOWN) {
      out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0;
      return out;
    }
    const inv = 1 / n;
    const smR = sR * inv, smG = sG * inv, smB = sB * inv;
    const tmR = tR * inv, tmG = tG * inv, tmB = tB * inv;
    const varS = (ssR * inv - smR * smR) + (ssG * inv - smG * smG) + (ssB * inv - smB * smB);
    const cov = (stR * inv - smR * tmR) + (stG * inv - smG * tmG) + (stB * inv - smB * tmB);
    const g = clamp((cov + ADAPT_REG) / (varS + ADAPT_REG), ADAPT_GAIN_MIN, ADAPT_GAIN_MAX);
    out[0] = g;
    out[1] = clamp(tmR - g * smR, -ADAPT_BIAS_MAX, ADAPT_BIAS_MAX);
    out[2] = clamp(tmG - g * smG, -ADAPT_BIAS_MAX, ADAPT_BIAS_MAX);
    out[3] = clamp(tmB - g * smB, -ADAPT_BIAS_MAX, ADAPT_BIAS_MAX);
    return out;
  }

  const scratch = new Float32Array(4);

  /* Fits one patch. Moments accumulate over known pixels only: an unsolved hole
   * pixel is not evidence about exposure. */
  function fitPatch(pixels, mask, width, height, tx, ty, sx, sy, transform, radius, out) {
    const { T_A, T_B, T_C, T_D } = CAF.patchDistance;
    const a = T_A[transform], b = T_B[transform], c = T_C[transform], d = T_D[transform];
    let n = 0;
    let sR = 0, sG = 0, sB = 0, tR = 0, tG = 0, tB = 0;
    let ssR = 0, ssG = 0, ssB = 0, stR = 0, stG = 0, stB = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const tyy = ty + dy;
      if (tyy < 0 || tyy >= height) continue;
      const tRow = tyy * width;
      for (let dx = -radius; dx <= radius; dx++) {
        const txx = tx + dx;
        if (txx < 0 || txx >= width) continue;
        const ti = tRow + txx;
        if (mask[ti]) continue;
        const sxx = sx + a * dx + b * dy;
        const syy = sy + c * dx + d * dy;
        if (sxx < 0 || sxx >= width || syy < 0 || syy >= height) continue;
        const sp = (syy * width + sxx) * 4;
        const tp = ti * 4;
        const sr = pixels[sp], sg = pixels[sp + 1], sb = pixels[sp + 2];
        const tr = pixels[tp], tg = pixels[tp + 1], tb = pixels[tp + 2];
        sR += sr; sG += sg; sB += sb;
        tR += tr; tG += tg; tB += tb;
        ssR += sr * sr; ssG += sg * sg; ssB += sb * sb;
        stR += sr * tr; stG += sg * tg; stB += sb * tb;
        n++;
      }
    }
    solveFit(n, sR, sG, sB, tR, tG, tB, ssR, ssG, ssB, stR, stG, stB, out);
    return n;
  }

  /* Per-hole-pixel gain and bias for a whole pass. `strength` is §19's 0..1
   * control: 0 preserves the patch exactly, 1 applies the full fit.
   *
   * Only pixels whose patch contains enough known material get adapted, which in
   * practice is a band about one patch wide inside the boundary. Deeper in the
   * hole there is nothing to fit against, and inventing a correction there would
   * be a slow drift across the fill rather than a match to anything. */
  function buildField(ctx, state) {
    const { width, height, radius } = ctx;
    const { nnf, hole, pixels, mask, strength } = state;
    const n = hole.length;
    const gain = new Float32Array(n).fill(1);
    const biasR = new Float32Array(n);
    const biasG = new Float32Array(n);
    const biasB = new Float32Array(n);
    if (!(strength > 0)) return { gain, biasR, biasG, biasB, adapted: 0 };

    const s = clamp(strength, 0, 1);
    let adapted = 0;
    for (let k = 0; k < n; k++) {
      const p = hole[k];
      const sx = nnf.x[p];
      if (sx < 0) continue;
      const fitted = fitPatch(pixels, mask, width, height,
        p % width, (p / width) | 0, sx, nnf.y[p], nnf.t[p], radius, scratch);
      if (fitted < ADAPT_MIN_KNOWN) continue;
      // Blend toward identity by `strength` rather than scaling the fit, so a
      // half-strength adaptation is half the correction, not half the gain.
      gain[k] = 1 + (scratch[0] - 1) * s;
      biasR[k] = scratch[1] * s;
      biasG[k] = scratch[2] * s;
      biasB[k] = scratch[3] * s;
      adapted++;
    }
    return { gain, biasR, biasG, biasB, adapted };
  }

  CAF.colorAdapter = {
    ADAPT_GAIN_MIN,
    ADAPT_GAIN_MAX,
    ADAPT_BIAS_MAX,
    ADAPT_MIN_KNOWN,
    solveFit,
    fitPatch,
    buildField,
  };
})(typeof self !== 'undefined' ? self : globalThis);
