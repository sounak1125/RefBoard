'use strict';
/* Patch reconstruction (§13).
 *
 * Every hole pixel is covered by (2r+1)^2 overlapping patches, and each of them
 * gets a say weighted by how good its match was. Averaging many candidates is
 * what removes the block artefacts a one-patch-per-pixel copy produces.
 *
 * The catch — and the reason the previous engine was abandoned as "smudging" —
 * is that averaging is only safe while the candidates genuinely agree. With a
 * fixed vote width, the finest level keeps averaging thousands of unrelated
 * fragments and the result goes soft.
 *
 * So sigma is annealed. Early passes vote wide, which lets competing hypotheses
 * blend and lets the field settle; late passes vote narrow, approaching
 * winner-take-all, so the final image is made of decisive choices. `sharpness`
 * is the annealing knob, raised by the orchestrator as it descends the pyramid.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp } = CAF;

  /* Gaussian on the in-patch offset: a patch speaks most confidently about its
   * own centre. */
  function buildSpatialWeights(radius) {
    const side = radius * 2 + 1;
    const w = new Float32Array(side * side);
    const sigma = Math.max(0.75, radius / 2);
    const inv = 1 / (2 * sigma * sigma);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        w[(dy + radius) * side + (dx + radius)] = Math.exp(-(dx * dx + dy * dy) * inv);
      }
    }
    return w;
  }

  /* Vote width, taken from the distribution of match costs actually achieved.
   * A hole where everything matched well votes tightly; one where nothing did
   * votes broadly rather than committing to a bad winner. */
  function voteSigma2(nnf, hole, sharpness) {
    const sample = [];
    const step = Math.max(1, (hole.length / 4096) | 0);
    for (let k = 0; k < hole.length; k += step) {
      const d = nnf.d[hole[k]];
      if (Number.isFinite(d)) sample.push(d);
    }
    const p75 = CAF.percentile(sample, 0.75, 1);
    const base = p75 > 1e-6 ? p75 : 1e-6;
    return base / Math.max(1, sharpness);
  }

  /* Weighted vote over every covering patch.
   *
   * `adapt` is optional per-hole-pixel colour adaptation (§19): gain and bias
   * applied to the source sample as it is cast, so adaptation happens inside the
   * average rather than being smeared over the result afterwards.
   *
   * Returns per-pixel agreement (winning weight over total weight) and cost,
   * which is what the confidence map is built from.
   */
  function reconstruct(ctx, state) {
    const { width, height, radius } = ctx;
    const { nnf, hole, holeIndex, source, out, sharpness, adapt, mask } = state;
    const total = width * height;
    const side = radius * 2 + 1;
    const spatial = state.spatial || buildSpatialWeights(radius);
    const sigma2 = state.sigma2 !== undefined ? state.sigma2 : voteSigma2(nnf, hole, sharpness || 1);
    const invSigma = 1 / (2 * (sigma2 > 1e-9 ? sigma2 : 1e-9));
    const { T_A, T_B, T_C, T_D } = CAF.patchDistance;

    const acc = state.acc || new Float32Array(total * 4);
    const wsum = state.wsum || new Float32Array(total);
    const wmax = state.wmax || new Float32Array(total);
    const cost = state.cost || new Float32Array(total);
    acc.fill(0); wsum.fill(0); wmax.fill(0); cost.fill(0);

    for (let k = 0; k < hole.length; k++) {
      const q = hole[k];
      const sx = nnf.x[q];
      if (sx < 0) continue;
      const sy = nnf.y[q];
      const t = nnf.t[q];
      const a = T_A[t], b = T_B[t], c = T_C[t], d = T_D[t];
      const qx = q % width;
      const qy = (q / width) | 0;

      const dist = Number.isFinite(nnf.d[q]) ? nnf.d[q] : 1e6;
      // Floored so no pixel is ever left holding its bootstrap value because
      // every patch covering it happened to score badly.
      let quality = Math.exp(-dist * invSigma);
      if (!(quality > 1e-6)) quality = 1e-6;

      const gain = adapt ? adapt.gain[k] : 1;
      const biasR = adapt ? adapt.biasR[k] : 0;
      const biasG = adapt ? adapt.biasG[k] : 0;
      const biasB = adapt ? adapt.biasB[k] : 0;

      for (let dy = -radius; dy <= radius; dy++) {
        const ty = qy + dy;
        if (ty < 0 || ty >= height) continue;
        const trow = ty * width;
        const srow = (dy + radius) * side + radius;
        for (let dx = -radius; dx <= radius; dx++) {
          const tx = qx + dx;
          if (tx < 0 || tx >= width) continue;
          const ti = trow + tx;
          if (!mask[ti]) continue;          // known pixels are never rewritten
          const weight = quality * spatial[srow + dx];
          const si = ((sy + c * dx + d * dy) * width + (sx + a * dx + b * dy)) * 4;
          const to = ti * 4;
          acc[to] += weight * (source[si] * gain + biasR);
          acc[to + 1] += weight * (source[si + 1] * gain + biasG);
          acc[to + 2] += weight * (source[si + 2] * gain + biasB);
          acc[to + 3] += weight * source[si + 3];
          wsum[ti] += weight;
          cost[ti] += weight * dist;
          if (weight > wmax[ti]) wmax[ti] = weight;
        }
      }
    }

    const agreement = state.agreement || new Float32Array(total);
    for (let i = 0; i < total; i++) {
      if (!mask[i]) { agreement[i] = 1; continue; }
      const w = wsum[i];
      const o = i * 4;
      if (w > 1e-9) {
        out[o] = acc[o] / w;
        out[o + 1] = acc[o + 1] / w;
        out[o + 2] = acc[o + 2] / w;
        out[o + 3] = acc[o + 3] / w;
        agreement[i] = clamp(wmax[i] / w, 0, 1);
        cost[i] = cost[i] / w;
      } else {
        // No patch reached this pixel. Leave whatever the coarser level put
        // there and record that nothing supports it.
        agreement[i] = 0;
        cost[i] = 1e6;
      }
    }

    return { agreement, cost, sigma2, wsum, acc, wmax };
  }

  /* The finest level finishes here (§13's block-artefact concern answered by
   * §35's "prefer real pixels"): each hole pixel takes its own winning source
   * verbatim, so the output is contiguous pieces of the actual photograph rather
   * than an average. Seam routing between the pieces is the seam blender's job.
   *
   * Only ever used after the field has been made coherent; on a fragmented field
   * this would produce visible tiling, which is why the coherence term exists in
   * the search. */
  function coherentCopy(ctx, state) {
    const { width, height } = ctx;
    const { nnf, hole, source, out, mask, adapt } = state;
    let copied = 0;
    for (let k = 0; k < hole.length; k++) {
      const p = hole[k];
      const sx = nnf.x[p];
      if (sx < 0) continue;
      const sy = nnf.y[p];
      const si = (sy * width + sx) * 4;
      const o = p * 4;
      const gain = adapt ? adapt.gain[k] : 1;
      out[o] = clamp(source[si] * gain + (adapt ? adapt.biasR[k] : 0), 0, 255);
      out[o + 1] = clamp(source[si + 1] * gain + (adapt ? adapt.biasG[k] : 0), 0, 255);
      out[o + 2] = clamp(source[si + 2] * gain + (adapt ? adapt.biasB[k] : 0), 0, 255);
      out[o + 3] = source[si + 3];
      copied++;
    }
    return copied;
  }

  CAF.patchVoting = {
    buildSpatialWeights,
    voteSigma2,
    reconstruct,
    coherentCopy,
  };
})(typeof self !== 'undefined' ? self : globalThis);
