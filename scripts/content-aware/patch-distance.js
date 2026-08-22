'use strict';
/* Patch distance (§9).
 *
 *   distance = colour + gradient + structure + validity weighting + locality
 *
 * Colour is CIELAB, not raw sRGB: a numeric difference then means roughly the
 * same perceptual difference across the whole gamut, so a match in shadow is
 * judged on the same scale as one in bright sky.
 *
 * Validity weighting is the part §9 is most specific about. A patch straddling
 * the hole boundary must be judged on the pixels that are actually known; the
 * half sitting over unsolved reconstruction should barely count. That is exactly
 * what the confidence map holds, so it is used directly as the per-pixel weight
 * — which also satisfies §35, since original photograph weighs 1.0 and anything
 * synthesised weighs less.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp, LAB_SCALE } = CAF;

  // A mean squared difference of deltaE 10 normalises to 1.
  const COLOR_NORM = LAB_SCALE * LAB_SCALE * 100;
  // Two Sobel channels, each around 30 on a clear edge.
  const GRAD_NORM = 1800;

  /* Dihedral group of the square: (dx, dy) -> (a*dx + b*dy, c*dx + d*dy).
   * Index 0 is the identity, so a run with transforms disabled never touches
   * any of this. */
  const T_A = [1, 0, -1, 0, -1, 0, 1, 0];
  const T_B = [0, -1, 0, 1, 0, 1, 0, -1];
  const T_C = [0, 1, 0, -1, 0, 1, 0, -1];
  const T_D = [1, 0, -1, 0, 1, 0, -1, 0];

  /* Which transforms a given options set permits. Mirror and rotation are
   * separate knobs (§20) so "mirror only" is expressible. */
  function transformSet(options) {
    const set = [0];
    const rot = options.rotationLevel | 0;
    if (rot >= 1) set.push(2);            // 180
    if (rot >= 2) { set.push(1, 3); }     // 90, 270
    if (options.mirror) {
      set.push(4);                        // mirror x
      if (rot >= 1) set.push(6);          // mirror y
      if (rot >= 3) set.push(5, 7);       // the remaining reflections
    }
    return Uint8Array.from(set);
  }

  /* Total confidence weight of the patch around each hole pixel. Depends only on
   * the target, so it is computed once per pass and the hot loop reads it — and
   * because it is known up front, a partial score can be compared against the
   * incumbent mid-loop and abandoned early. */
  function buildPatchWeights(hole, confidence, mask, width, height, radius, stride) {
    const step = Math.max(1, stride | 0);
    const weights = new Float32Array(hole.length);
    for (let k = 0; k < hole.length; k++) {
      const p = hole[k];
      const px = p % width;
      const py = (p / width) | 0;
      let sum = 0;
      for (let dy = -radius; dy <= radius; dy += step) {
        const ty = py + dy;
        if (ty < 0 || ty >= height) continue;
        const row = ty * width;
        for (let dx = -radius; dx <= radius; dx += step) {
          const tx = px + dx;
          if (tx < 0 || tx >= width) continue;
          // A known pixel always weighs 1; a reconstructed one weighs its trust,
          // floored so an all-interior patch still has a usable gradient.
          const c = confidence[row + tx];
          sum += c > 0.05 ? c : 0.05;
        }
      }
      weights[k] = sum > 0 ? sum : 1;
    }
    return weights;
  }

  /* `ctx` is one pyramid level's working state. The returned scorer closes over
   * it so the inner loop reads monomorphic typed arrays with no property
   * lookups on the hot path. */
  function createScorer(ctx) {
    const {
      width, height, radius, lab, gx, gy, sd, confidence, weights,
    } = ctx;
    const colorW = ctx.colorWeight;
    const gradW = ctx.gradientWeight;
    const structW = ctx.structureWeight;
    const locW = ctx.localityWeight;
    const localityRef = ctx.localityRef > 1 ? ctx.localityRef : 1;
    const structure = CAF.structureAnalyzer;
    /* Compare every `step`-th pixel of the patch rather than all of them.
     *
     * Distance is by far the hottest loop in the engine — around 80% of a fill's
     * runtime — and it costs the patch area per candidate. At stride 2 a 9x9
     * patch is judged on 25 samples instead of 81, still spread across its whole
     * footprint, which is ample for deciding which of two candidates matches
     * better. It is what makes the Preview preset genuinely a preview. */
    const step = Math.max(1, ctx.patchStride | 0);

    /* Distance between the patch centred on target pixel `p` and the one centred
     * on (sx, sy) under `transform`. `best` is the incumbent; anything already
     * worse is abandoned. Returns Infinity when abandoned. */
    return function score(p, holeIndex, sx, sy, transform, best) {
      const px = p % width;
      const py = (p / width) | 0;
      const wsum = weights[holeIndex];
      const invColor = colorW / (wsum * COLOR_NORM);
      const invGrad = gradW / (wsum * GRAD_NORM);

      // Position-only terms first: they are cheap and can rule a candidate out
      // before a single pixel is compared.
      let total = 0;
      if (locW > 0) {
        const ddx = sx - px, ddy = sy - py;
        total += locW * (Math.sqrt(ddx * ddx + ddy * ddy) / localityRef);
      }
      if (structW > 0) {
        total += structW * structure.term(sd, p, sy * width + sx);
      }
      if (total >= best) return Infinity;

      const a = T_A[transform], b = T_B[transform], c = T_C[transform], d = T_D[transform];
      let colorAcc = 0, gradAcc = 0;

      for (let dy = -radius; dy <= radius; dy += step) {
        const ty = py + dy;
        if (ty < 0 || ty >= height) continue;
        const trow = ty * width;
        for (let dx = -radius; dx <= radius; dx += step) {
          const tx = px + dx;
          if (tx < 0 || tx >= width) continue;
          const ti = trow + tx;
          const cw = confidence[ti] > 0.05 ? confidence[ti] : 0.05;

          const si = (sy + c * dx + d * dy) * width + (sx + a * dx + b * dy);

          const to = ti * 3, so = si * 3;
          const dL = lab[to] - lab[so];
          const da = lab[to + 1] - lab[so + 1];
          const db = lab[to + 2] - lab[so + 2];
          colorAcc += cw * (dL * dL + da * da + db * db);

          if (gradW > 0) {
            // The source gradient is a vector, so it rotates with the patch:
            // apply the same linear map to (gx, gy) before comparing.
            const sgx = gx[si], sgy = gy[si];
            const rgx = a * sgx + b * sgy;
            const rgy = c * sgx + d * sgy;
            const ex = gx[ti] - rgx;
            const ey = gy[ti] - rgy;
            gradAcc += cw * (ex * ex + ey * ey);
          }
        }
        // Partial sums only grow, so this bound is sound.
        if (total + colorAcc * invColor + gradAcc * invGrad >= best) return Infinity;
      }

      return total + colorAcc * invColor + gradAcc * invGrad;
    };
  }

  CAF.patchDistance = {
    COLOR_NORM,
    GRAD_NORM,
    T_A, T_B, T_C, T_D,
    transformSet,
    buildPatchWeights,
    createScorer,
  };
})(typeof self !== 'undefined' ? self : globalThis);
