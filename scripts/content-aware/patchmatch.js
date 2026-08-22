'use strict';
/* PatchMatch iteration (§10) and random search (§11).
 *
 * Barnes et al.'s randomised correspondence algorithm: propagate good matches to
 * neighbours along the scan direction, then probe exponentially shrinking
 * neighbourhoods around the current best.
 *
 * One deliberate addition. The previous engine applied offset coherence only
 * when *voting*, never when *searching*, so the field it voted over was already
 * fragmented — measured on a real removal, a 19,058 pixel hole assembled from
 * 9,754 source fragments of median size two pixels. Averaging thousands of
 * unrelated fragments is precisely what reads as a smudge. Here disagreement
 * with a neighbour's offset is part of the cost, so the search itself is pulled
 * toward large contiguous pieces of the photograph.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp } = CAF;

  /* Offsets closer together than this count as partial agreement, so a gently
   * warping source region is not punished like a jump across the frame. */
  const COHERENCE_REF = 6;

  function run(ctx, state) {
    const {
      width, height, radius,
    } = ctx;
    const {
      nnf, hole, holeIndex, centers, scorer, iterations, searchRadius,
      transforms, random, onProgress, shouldCancel, coherenceWeight,
    } = state;

    if (!centers.count) return { improved: 0, evaluated: 0 };

    const cohRef = state.coherenceRef > 0 ? state.coherenceRef : COHERENCE_REF;
    const cohRef2 = cohRef * cohRef;
    const cohW = coherenceWeight || 0;
    const { T_A, T_B, T_C, T_D } = CAF.patchDistance;
    const multiTransform = transforms && transforms.length > 1;

    let evaluated = 0;
    let improved = 0;

    /* Mean squared offset disagreement with the 4-neighbours that already hold a
     * match, normalised to 0..1. Cheap enough to compute before scoring, which
     * lets it tighten the early-out budget too. */
    function coherencePenalty(p, px, py, ox, oy) {
      let pen = 0, n = 0;
      if (px > 0) {
        const q = p - 1;
        if (nnf.x[q] >= 0) { const dx = (nnf.x[q] - (px - 1)) - ox, dy = (nnf.y[q] - py) - oy; pen += Math.min(1, (dx * dx + dy * dy) / cohRef2); n++; }
      }
      if (px + 1 < width) {
        const q = p + 1;
        if (nnf.x[q] >= 0) { const dx = (nnf.x[q] - (px + 1)) - ox, dy = (nnf.y[q] - py) - oy; pen += Math.min(1, (dx * dx + dy * dy) / cohRef2); n++; }
      }
      if (py > 0) {
        const q = p - width;
        if (nnf.x[q] >= 0) { const dx = (nnf.x[q] - px) - ox, dy = (nnf.y[q] - (py - 1)) - oy; pen += Math.min(1, (dx * dx + dy * dy) / cohRef2); n++; }
      }
      if (py + 1 < height) {
        const q = p + width;
        if (nnf.x[q] >= 0) { const dx = (nnf.x[q] - px) - ox, dy = (nnf.y[q] - (py + 1)) - oy; pen += Math.min(1, (dx * dx + dy * dy) / cohRef2); n++; }
      }
      return n ? pen / n : 0;
    }

    /* Tests one candidate source for one target, and keeps it if it wins.
     * Every rejection path here is a §7 rule. */
    function tryCandidate(p, hi, px, py, sx, sy, transform) {
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) return;
      if (!centers.valid[sy * width + sx]) return;
      if (sx === nnf.x[p] && sy === nnf.y[p] && transform === nnf.t[p]) return;
      evaluated++;
      const penalty = cohW > 0 ? cohW * coherencePenalty(p, px, py, sx - px, sy - py) : 0;
      const budget = nnf.d[p] - penalty;
      if (budget <= 0) return;
      const d = scorer(p, hi, sx, sy, transform, budget);
      if (!(d < budget)) return;
      nnf.x[p] = sx;
      nnf.y[p] = sy;
      nnf.t[p] = transform;
      nnf.d[p] = d + penalty;
      improved++;
    }

    // Cost the incumbent once, so the first comparison is against something real
    // rather than Infinity.
    for (let k = 0; k < hole.length; k++) {
      const p = hole[k];
      if (nnf.x[p] < 0) continue;
      if (Number.isFinite(nnf.d[p])) continue;
      const px = p % width, py = (p / width) | 0;
      const d = scorer(p, k, nnf.x[p], nnf.y[p], nnf.t[p], Infinity);
      nnf.d[p] = Number.isFinite(d) ? d : 1e9;
    }

    for (let iter = 0; iter < iterations; iter++) {
      if (shouldCancel && shouldCancel()) break;
      const forward = (iter & 1) === 0;

      for (let idx = 0; idx < hole.length; idx++) {
        const k = forward ? idx : hole.length - 1 - idx;
        const p = hole[k];
        const px = p % width;
        const py = (p / width) | 0;

        /* --- propagation (§10) ---
         * A neighbour's match is offered after stepping it through the patch's
         * own symmetry: moving one pixel in target space moves by the matching
         * column of the transform matrix in source space. */
        if (forward) {
          if (px > 0) {
            const q = p - 1;
            if (nnf.x[q] >= 0) { const t = nnf.t[q]; tryCandidate(p, k, px, py, nnf.x[q] + T_A[t], nnf.y[q] + T_C[t], t); }
          }
          if (py > 0) {
            const q = p - width;
            if (nnf.x[q] >= 0) { const t = nnf.t[q]; tryCandidate(p, k, px, py, nnf.x[q] + T_B[t], nnf.y[q] + T_D[t], t); }
          }
        } else {
          if (px + 1 < width) {
            const q = p + 1;
            if (nnf.x[q] >= 0) { const t = nnf.t[q]; tryCandidate(p, k, px, py, nnf.x[q] - T_A[t], nnf.y[q] - T_C[t], t); }
          }
          if (py + 1 < height) {
            const q = p + width;
            if (nnf.x[q] >= 0) { const t = nnf.t[q]; tryCandidate(p, k, px, py, nnf.x[q] - T_B[t], nnf.y[q] - T_D[t], t); }
          }
        }

        /* --- random search (§11) --- */
        const baseX = nnf.x[p] >= 0 ? nnf.x[p] : px;
        const baseY = nnf.y[p] >= 0 ? nnf.y[p] : py;
        const curT = nnf.t[p];
        let r = searchRadius;
        while (r >= 1) {
          const sx = baseX + (((random() * 2 - 1) * r) | 0);
          const sy = baseY + (((random() * 2 - 1) * r) | 0);
          tryCandidate(p, k, px, py, sx, sy, curT);
          r = r >> 1;
        }

        /* --- transformed candidates (§20) ---
         * Only during refinement, and only around the position already won, so
         * enabling mirroring does not multiply the cost of the whole search. */
        if (multiTransform && iter > 0) {
          const alt = transforms[(random() * transforms.length) | 0];
          if (alt !== curT) tryCandidate(p, k, px, py, baseX, baseY, alt);
        }
      }

      if (onProgress) onProgress((iter + 1) / iterations);
    }

    return { improved, evaluated };
  }

  CAF.patchmatch = { COHERENCE_REF, run };
})(typeof self !== 'undefined' ? self : globalThis);
