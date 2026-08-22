'use strict';
/* Seam removal (§21).
 *
 * The rule that matters here is what NOT to touch. A gradient-domain solve over
 * the whole hole — which is what the previous engine did, 120 Gauss-Seidel
 * sweeps over every masked pixel — converges slowly in the interior and lets low
 * frequencies drift, so the reconstruction ends up hazed. Every bit of texture
 * PatchMatch just fought for gets averaged away by the thing that was supposed
 * to hide the seam.
 *
 * So the solve is confined to a narrow band: masked pixels within `edgeBlend` of
 * the hole boundary, plus masked pixels within `edgeBlend` of an internal
 * discontinuity where two neighbouring pixels came from unrelated parts of the
 * image. Everything deeper is a fixed boundary condition and keeps its detail
 * exactly. A global blur is never acceptable.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp } = CAF;

  // Offsets differing by more than this are treated as a genuine seam.
  const SEAM_OFFSET_TOL = 2;
  // Guidance attenuation floor: even across a seam, some real texture passes.
  const MIN_KEEP = 0.6;
  const AGREE_LAMBDA = 12.0;
  // A band larger than this share of the hole is not a seam band any more.
  const MAX_BAND_FRACTION = 0.4;
  const SWEEPS = 64;
  const OMEGA = 1.85;

  /* Masked pixels adjacent to known content (the rim), or adjacent to a
   * neighbour whose source offset is unrelated to their own *and* where that
   * actually shows as a colour step.
   *
   * The visibility test is what keeps the band narrow. A differing offset is
   * routine — on stochastic texture most neighbours disagree slightly — and
   * seeding on offset alone marks nearly every hole pixel, which grows into a
   * band covering the entire hole and turns this into the whole-region solve the
   * module exists to avoid. Only a step the eye could actually find is a seam.
   *
   * `allowance` is the local texture amplitude: differences the surroundings
   * already contain are not seams. */
  function seamSeeds(nnf, filled, mask, width, height, allowance) {
    const total = width * height;
    const seeds = new Uint8Array(total);
    const limit = allowance > 0 ? allowance : 12;
    for (let p = 0; p < total; p++) {
      if (!mask[p]) continue;
      const px = p % width, py = (p / width) | 0;
      const ox = nnf.x[p] - px, oy = nnf.y[p] - py;
      let seed = false;
      for (let t = 0; t < 4 && !seed; t++) {
        const nx = px + (t === 0 ? -1 : t === 1 ? 1 : 0);
        const ny = py + (t === 2 ? -1 : t === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (!mask[q]) { seed = true; break; }         // the rim always blends
        if (nnf.x[q] < 0) continue;
        const dx = (nnf.x[q] - nx) - ox;
        const dy = (nnf.y[q] - ny) - oy;
        if (dx * dx + dy * dy <= SEAM_OFFSET_TOL * SEAM_OFFSET_TOL) continue;
        const a = p * 4, b = q * 4;
        const step = Math.hypot(filled[a] - filled[b], filled[a + 1] - filled[b + 1], filled[a + 2] - filled[b + 2]);
        if (step > limit) seed = true;
      }
      if (seed) seeds[p] = 1;
    }
    return seeds;
  }

  /* Rim-only seeds: masked pixels touching known content. The fallback when
   * internal seams turn out to be everywhere. */
  function rimSeeds(mask, width, height) {
    const total = width * height;
    const seeds = new Uint8Array(total);
    for (let p = 0; p < total; p++) {
      if (!mask[p]) continue;
      const px = p % width, py = (p / width) | 0;
      if ((px > 0 && !mask[p - 1]) || (px + 1 < width && !mask[p + 1])
        || (py > 0 && !mask[p - width]) || (py + 1 < height && !mask[p + width])) seeds[p] = 1;
    }
    return seeds;
  }

  /* Which masked pixels the solve is allowed to move.
   *
   * Hard-capped: §21's band is 2-8 pixels, so if the seeded band ever grows past
   * a fraction of the hole the internal seeds are discarded and only the rim is
   * blended. Better to leave an internal seam visible — which the quality report
   * will flag — than to quietly soften the whole reconstruction. */
  function buildBand(nnf, filled, mask, width, height, radius, allowance) {
    const holeCount = CAF.countMask(mask);
    let seeds = seamSeeds(nnf, filled, mask, width, height, allowance);
    if (radius <= 0) return { band: seeds, seeds, capped: false };

    /* Dilation is confined to the hole's bounding box plus the blend radius.
     * The band can only ever live inside the mask, so running the distance
     * transform across the whole region-of-interest — which on a megapixel crop
     * with a small hole is most of the work — buys nothing. */
    const bbox = CAF.maskBounds(mask, width, height);
    const pad = radius + 2;
    const bx0 = bbox ? Math.max(0, bbox.x0 - pad) : 0;
    const by0 = bbox ? Math.max(0, bbox.y0 - pad) : 0;
    const bw = bbox ? Math.min(width, bbox.x1 + pad) - bx0 : width;
    const bh = bbox ? Math.min(height, bbox.y1 + pad) - by0 : height;

    const grow = seedSet => {
      const sub = new Uint8Array(bw * bh);
      for (let y = 0; y < bh; y++) {
        const src = (by0 + y) * width + bx0;
        for (let x = 0; x < bw; x++) sub[y * bw + x] = seedSet[src + x];
      }
      const grown = CAF.dilateMask(sub, bw, bh, radius);
      const band = new Uint8Array(width * height);
      let n = 0;
      for (let y = 0; y < bh; y++) {
        const dst = (by0 + y) * width + bx0;
        for (let x = 0; x < bw; x++) {
          const i = dst + x;
          if (mask[i] && grown[y * bw + x]) { band[i] = 1; n++; }
        }
      }
      return { band, n };
    };

    let { band, n } = grow(seeds);
    let capped = false;
    if (holeCount > 0 && n > holeCount * MAX_BAND_FRACTION) {
      seeds = rimSeeds(mask, width, height);
      ({ band } = grow(seeds));
      capped = true;
    }
    return { band, seeds, capped };
  }

  /* Target gradient across the edge p->q, per channel.
   *
   * When q is fixed (known photograph, or interior the solve is not touching)
   * this is classic seamless cloning: the gradient the *source* patch would have
   * had if it continued in that direction, so the reconstruction meets the
   * original at the correct slope instead of at a step.
   *
   * When both are unknown, the composite's own difference passes through,
   * attenuated by how much the two offsets agree. Coherent texture is preserved
   * verbatim; a real seam is softened. */
  function guidance(nnf, filled, source, mask, width, height, p, q, channel) {
    const px = p % width, py = (p / width) | 0;
    const qx = q % width, qy = (q / width) | 0;
    const sx = nnf.x[p], sy = nnf.y[p];
    if (sx < 0) return 0;

    if (!mask[q]) {
      // Continue the source's own texture outward across the rim.
      const ex = sx + (qx - px), ey = sy + (qy - py);
      if (ex < 0 || ey < 0 || ex >= width || ey >= height) return 0;
      return source[(sy * width + sx) * 4 + channel] - source[(ey * width + ex) * 4 + channel];
    }

    const qsx = nnf.x[q], qsy = nnf.y[q];
    if (qsx < 0) return 0;
    const dx = (qsx - qx) - (sx - px);
    const dy = (qsy - qy) - (sy - py);
    const d2 = dx * dx + dy * dy;
    if (d2 === 0) {
      return source[(sy * width + sx) * 4 + channel] - source[(qsy * width + qsx) * 4 + channel];
    }
    const agree = Math.exp(-d2 / (2 * AGREE_LAMBDA * AGREE_LAMBDA));
    const keep = agree < MIN_KEEP ? MIN_KEEP : agree;
    return keep * (filled[p * 4 + channel] - filled[q * 4 + channel]);
  }

  /* Solves the Poisson system on the band by SOR. Everything outside the band —
   * known photograph and untouched interior alike — is Dirichlet data, so the
   * result cannot alter a single pixel the band does not cover. */
  function blend(ctx, state) {
    const { width, height } = ctx;
    const { nnf, filled, source, mask, radius, shouldCancel, allowance } = state;
    const total = width * height;
    const r = clamp(radius | 0, 0, 64);
    if (r <= 0) return { changed: 0, band: null };

    const { band, capped } = buildBand(nnf, filled, mask, width, height, r, allowance);
    const index = new Int32Array(total).fill(-1);
    const nodes = [];
    for (let i = 0; i < total; i++) {
      if (!band[i]) continue;
      index[i] = nodes.length;
      nodes.push(i);
    }
    if (!nodes.length) return { changed: 0, band, capped };

    const n = nodes.length;
    const values = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      const p = nodes[k] * 4;
      values[k * 3] = filled[p];
      values[k * 3 + 1] = filled[p + 1];
      values[k * 3 + 2] = filled[p + 2];
    }

    // Precompute each node's neighbours and the summed guidance, so the sweeps
    // are pure arithmetic.
    const nbIndex = new Int32Array(n * 4).fill(-2);
    const fixedSum = new Float32Array(n * 3);
    const degree = new Int32Array(n);
    for (let k = 0; k < n; k++) {
      const p = nodes[k];
      const px = p % width, py = (p / width) | 0;
      let deg = 0;
      for (let t = 0; t < 4; t++) {
        const nx = px + (t === 0 ? -1 : t === 1 ? 1 : 0);
        const ny = py + (t === 2 ? -1 : t === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) { nbIndex[k * 4 + t] = -2; continue; }
        const q = ny * width + nx;
        deg++;
        const g0 = guidance(nnf, filled, source, mask, width, height, p, q, 0);
        const g1 = guidance(nnf, filled, source, mask, width, height, p, q, 1);
        const g2 = guidance(nnf, filled, source, mask, width, height, p, q, 2);
        fixedSum[k * 3] += g0;
        fixedSum[k * 3 + 1] += g1;
        fixedSum[k * 3 + 2] += g2;
        const j = index[q];
        if (j >= 0) {
          nbIndex[k * 4 + t] = j;
        } else {
          nbIndex[k * 4 + t] = -1;
          // Dirichlet contribution from a pixel the solve may not move.
          const qp = q * 4;
          fixedSum[k * 3] += filled[qp];
          fixedSum[k * 3 + 1] += filled[qp + 1];
          fixedSum[k * 3 + 2] += filled[qp + 2];
        }
      }
      degree[k] = deg > 0 ? deg : 1;
    }

    for (let sweep = 0; sweep < SWEEPS; sweep++) {
      if (shouldCancel && (sweep & 7) === 0 && shouldCancel()) break;
      // Alternate direction so information travels both ways across the band.
      const forward = (sweep & 1) === 0;
      for (let i = 0; i < n; i++) {
        const k = forward ? i : n - 1 - i;
        const deg = degree[k];
        let s0 = fixedSum[k * 3], s1 = fixedSum[k * 3 + 1], s2 = fixedSum[k * 3 + 2];
        for (let t = 0; t < 4; t++) {
          const j = nbIndex[k * 4 + t];
          if (j < 0) continue;
          s0 += values[j * 3];
          s1 += values[j * 3 + 1];
          s2 += values[j * 3 + 2];
        }
        values[k * 3] += OMEGA * (s0 / deg - values[k * 3]);
        values[k * 3 + 1] += OMEGA * (s1 / deg - values[k * 3 + 1]);
        values[k * 3 + 2] += OMEGA * (s2 / deg - values[k * 3 + 2]);
      }
    }

    let changed = 0;
    for (let k = 0; k < n; k++) {
      const p = nodes[k] * 4;
      const r0 = clamp(values[k * 3], 0, 255);
      const r1 = clamp(values[k * 3 + 1], 0, 255);
      const r2 = clamp(values[k * 3 + 2], 0, 255);
      if (filled[p] !== r0 || filled[p + 1] !== r1 || filled[p + 2] !== r2) changed++;
      filled[p] = r0;
      filled[p + 1] = r1;
      filled[p + 2] = r2;
    }
    return { changed, band, capped, nodes: n };
  }

  CAF.seamBlender = {
    SEAM_OFFSET_TOL,
    SWEEPS,
    MAX_BAND_FRACTION,
    seamSeeds,
    rimSeeds,
    buildBand,
    guidance,
    blend,
  };
})(typeof self !== 'undefined' ? self : globalThis);
