'use strict';
/* Multi-resolution pyramid (§12).
 *
 * Large structure is decided at the coarsest level, where a whole building
 * facade is a handful of pixels and a single patch can span it; fine texture is
 * refined at full resolution, where a patch covers a few blades of grass. Doing
 * only one full-resolution pass is what leaves large holes looking like a mosaic
 * of unrelated fragments.
 *
 * Colour is downsampled with a binomial (Gaussian) kernel weighted so masked
 * pixels contribute nothing — otherwise the object being erased bleeds into the
 * coarse levels and the whole pyramid is solving the wrong problem.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp } = CAF;

  const MIN_SIDE = 24;

  // Separable [1 4 6 4 1] / 16.
  const K = [1, 4, 6, 4, 1];

  /* Halves an RGBA image plus its masks. `mask` is OR-reduced so the hole can
   * never vanish at a coarse level (§12); `allowed` is AND-reduced so a coarse
   * source pixel is only legal when every pixel it stands for was legal. */
  function downsample(pixels, mask, allowed, width, height) {
    const outW = Math.max(1, width >> 1);
    const outH = Math.max(1, height >> 1);
    const outPixels = new Uint8ClampedArray(outW * outH * 4);
    const outMask = new Uint8Array(outW * outH);
    const outAllowed = allowed ? new Uint8Array(outW * outH) : null;

    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const cx = x * 2;
        const cy = y * 2;
        let r = 0, g = 0, b = 0, a = 0, wsum = 0;
        let rr = 0, gg = 0, bb = 0, aa = 0, plain = 0;
        let masked = 0;
        let allAllowed = 1;
        for (let ky = 0; ky < 5; ky++) {
          const sy = clamp(cy + ky - 2, 0, height - 1);
          for (let kx = 0; kx < 5; kx++) {
            const sx = clamp(cx + kx - 2, 0, width - 1);
            const i = sy * width + sx;
            const p = i * 4;
            const kw = K[ky] * K[kx];
            rr += pixels[p] * kw; gg += pixels[p + 1] * kw; bb += pixels[p + 2] * kw; aa += pixels[p + 3] * kw;
            plain += kw;
            if (mask[i]) continue;
            r += pixels[p] * kw; g += pixels[p + 1] * kw; b += pixels[p + 2] * kw; a += pixels[p + 3] * kw;
            wsum += kw;
          }
        }
        // Coverage-aware reduction over the 2x2 block this output pixel stands for.
        for (let dy = 0; dy < 2; dy++) {
          const sy = Math.min(height - 1, cy + dy);
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(width - 1, cx + dx);
            const i = sy * width + sx;
            if (mask[i]) masked = 1;
            if (allowed && !allowed[i]) allAllowed = 0;
          }
        }
        const o = (y * outW + x) * 4;
        if (wsum > 0) {
          outPixels[o] = r / wsum; outPixels[o + 1] = g / wsum;
          outPixels[o + 2] = b / wsum; outPixels[o + 3] = a / wsum;
        } else {
          // Entirely inside the hole: the value is a placeholder that the solve
          // overwrites, but it must still be finite.
          outPixels[o] = rr / plain; outPixels[o + 1] = gg / plain;
          outPixels[o + 2] = bb / plain; outPixels[o + 3] = aa / plain;
        }
        outMask[y * outW + x] = masked;
        if (outAllowed) outAllowed[y * outW + x] = masked ? 0 : allAllowed;
      }
    }
    return { pixels: outPixels, mask: outMask, allowed: outAllowed, width: outW, height: outH };
  }

  /* Levels are returned finest-first at index 0, so callers walk backwards to
   * go coarse-to-fine. Stops early rather than producing a level where the hole
   * has shrunk to nothing useful. */
  function build(pixels, mask, allowed, width, height, maxLevels) {
    const levels = [{ pixels, mask, allowed, width, height }];
    let cur = levels[0];
    while (levels.length < maxLevels) {
      if ((cur.width >> 1) < MIN_SIDE || (cur.height >> 1) < MIN_SIDE) break;
      const next = downsample(cur.pixels, cur.mask, cur.allowed, cur.width, cur.height);
      if (!CAF.countMask(next.mask)) break;
      levels.push(next);
      cur = next;
    }
    return levels;
  }

  /* Bilinear upsample of the reconstructed colour into the finer level's hole.
   * Known pixels are left exactly as they were — this only bootstraps the hole
   * before the finer level's own matching refines it. */
  function upsampleInto(coarse, coarseW, coarseH, finePixels, fineMask, fineW, fineH) {
    const sx = coarseW / fineW;
    const sy = coarseH / fineH;
    for (let y = 0; y < fineH; y++) {
      const fy = clamp(y * sy, 0, coarseH - 1);
      const y0 = fy | 0;
      const y1 = Math.min(coarseH - 1, y0 + 1);
      const wy = fy - y0;
      for (let x = 0; x < fineW; x++) {
        const i = y * fineW + x;
        if (!fineMask[i]) continue;
        const fx = clamp(x * sx, 0, coarseW - 1);
        const x0 = fx | 0;
        const x1 = Math.min(coarseW - 1, x0 + 1);
        const wx = fx - x0;
        const p00 = (y0 * coarseW + x0) * 4;
        const p01 = (y0 * coarseW + x1) * 4;
        const p10 = (y1 * coarseW + x0) * 4;
        const p11 = (y1 * coarseW + x1) * 4;
        const o = i * 4;
        for (let c = 0; c < 4; c++) {
          const top = coarse[p00 + c] * (1 - wx) + coarse[p01 + c] * wx;
          const bot = coarse[p10 + c] * (1 - wx) + coarse[p11 + c] * wx;
          finePixels[o + c] = top * (1 - wy) + bot * wy;
        }
      }
    }
    return finePixels;
  }

  CAF.imagePyramid = {
    MIN_SIDE,
    downsample,
    build,
    upsampleInto,
  };
})(typeof self !== 'undefined' ? self : globalThis);
