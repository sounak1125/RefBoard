'use strict';
/* Option normalisation and the three quality presets.
 *
 * Everything is `auto` by default. `resolve()` turns a caller's partial options
 * plus measurements of the actual image and mask into a fully concrete settings
 * object, so no other module ever has to reason about defaults.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp } = CAF;

  const QUALITIES = ['preview', 'balanced', 'high'];

  /* Per-preset knobs. `roiScale` multiplies the contextual margin around the
   * hole; `passes` is how many reconstruct/refine rounds the finest level gets. */
  const PRESETS = {
    preview: {
      iterations: 3,
      maxLevels: 3,
      searchScale: 0.45,
      roiScale: 0.7,
      passes: 1,
      colorAdaptation: 0.35,
      mirror: false,
      rotationAdaptation: 'off',
      scaleAdaptation: 'off',
      voteRadiusScale: 0.75,
      patchStride: 2,
    },
    balanced: {
      iterations: 5,
      maxLevels: 4,
      searchScale: 1,
      roiScale: 1,
      passes: 2,
      colorAdaptation: 0.5,
      mirror: false,
      rotationAdaptation: 'off',
      scaleAdaptation: 'off',
      voteRadiusScale: 1,
      patchStride: 1,
    },
    high: {
      iterations: 8,
      maxLevels: 5,
      searchScale: 1.6,
      roiScale: 1.35,
      passes: 3,
      colorAdaptation: 0.6,
      mirror: true,
      rotationAdaptation: 'low',
      scaleAdaptation: 'off',
      voteRadiusScale: 1,
      patchStride: 1,
    },
  };

  const ROTATION_LEVELS = { off: 0, low: 1, medium: 2, high: 3 };
  const SCALE_LEVELS = { off: 0, low: 1, medium: 2 };

  /* Above this many pixels to reconstruct, a preset stops spending refinement
   * it cannot pay for.
   *
   * Matching is 70-90% of a fill and scales with the hole, so the presets' fixed
   * budgets stop making sense at the top end: a 4.5-megapixel selection on a
   * 24-megapixel photo took 860s at Balanced, past the host's own time budget,
   * and was cancelled rather than finishing. The two adaptations — one fewer
   * reconstruction pass, and no patch-size bump — were measured on a 588k-pixel
   * hole at 50.0s -> 28.6s with RMSE 12.1 -> 12.2 and texture retention
   * 0.92 -> 0.91. Effectively the same picture in half the time.
   *
   * Set where it catches only the cases that actually overrun: every benchmark
   * row below 1.5M finishes comfortably inside its budget already, so they keep
   * their full quality settings. */
  const HUGE_HOLE = 1500000;

  /* Odd patch side in 5..11, per §6.
   *
   * Two signals drive it. Texture frequency: fine grain wants a small patch so
   * matches stay local, coarse repetitive texture wants a large one so the
   * repeat is captured rather than sliced. Hole size: a big hole needs bigger
   * patches or the reconstruction fragments, which is exactly the failure the
   * previous engine measured.
   *
   * The thresholds are in mean-absolute-luma-gradient units, calibrated against
   * the reference scenes: a plaster wall lands near 0.4, smooth sky near 1.1,
   * brickwork near 3.4, dense grass near 6.
   *
   * These come out larger than §6's suggested starting point, and deliberately.
   * Swept over the five reference scenes with everything else fixed, mean RMSE
   * inside the hole fell monotonically with patch size — 21.2 at 5, 17.2 at 7,
   * 13.1 at 9, 11.8 at 11 — and mean texture-ratio error fell with it (0.50,
   * 0.42, 0.33, 0.33). Voting is the reason: a larger patch puts more
   * overlapping votes on each pixel, so the average is taken over candidates
   * that agree rather than over near-arbitrary matches. Small patches are the
   * right call for a single-patch-copy synthesiser, which this is not. Cost
   * grows as the square, so 11 is the ceiling. */
  function autoPatchSize(holeArea, roiArea, textureFrequency) {
    let size = 9;
    if (textureFrequency < 1.4) size = 11;      // smooth, or a large repeat
    else if (textureFrequency > 12) size = 7;   // exceptionally fine grain
    /* A hole that fills much of its region needs a bigger patch to stay
     * coherent — but only up to a point. Matching cost is the hole area times
     * the patch area, so on a very large selection this bump is the single most
     * expensive decision in the engine, and measured on a 588k-pixel hole it
     * bought nothing: patch 11 scored RMSE 12.1 / texture 0.92 against patch 9's
     * 12.2 / 0.91, for 1.5x the work. Past HUGE_HOLE it is not applied. */
    if (holeArea > roiArea * 0.1 && holeArea <= HUGE_HOLE) size += 2;
    // A patch wider than the hole cannot straddle the boundary usefully.
    if (holeArea < 900) size -= 2;
    if (holeArea > HUGE_HOLE) size = Math.min(size, 9);
    return clamp(size | 1, 5, 11);
  }

  /* §12: enough levels that the coarsest is small enough for large structure to
   * be decided globally, but never so small the hole vanishes. */
  function autoPyramidLevels(width, height, holeArea, maxLevels) {
    const shortest = Math.min(width, height);
    let levels = 1;
    let w = width, h = height, hole = holeArea;
    while (levels < maxLevels && (w >> 1) >= 32 && (h >> 1) >= 32 && hole > 64) {
      w >>= 1; h >>= 1; hole /= 4;
      levels++;
    }
    if (shortest < 64) levels = 1;
    return clamp(levels, 1, maxLevels);
  }

  function autoSearchRadius(width, height, scale) {
    return clamp(Math.round(Math.max(width, height) * 0.5 * scale), 8, 4096);
  }

  /* §25: how far to grow the removal mask so the object's own halo pixels get
   * replaced rather than reused as source material. */
  function autoMaskExpansion(imageLongEdge) {
    return clamp(Math.round(imageLongEdge * 0.002), 2, 5);
  }

  /* §18: the forbidden-sampling zone is dilated further than the fill mask so
   * contaminated pixels right beside the removed object are never sampled. */
  function autoForbiddenDilation(imageLongEdge, patchSize) {
    const base = Math.round(imageLongEdge * 0.004);
    return clamp(Math.max(base, (patchSize >> 1) + 1), 3, 15);
  }

  /* §21: the blend band is narrow by design. Blending the whole region is what
   * destroys the high-frequency detail the reconstruction just built. */
  function autoEdgeBlend(patchSize, holeArea) {
    const fromHole = Math.round(Math.sqrt(Math.max(1, holeArea)) * 0.05);
    return clamp(Math.max(patchSize >> 1, fromHole), 2, 8);
  }

  /* Mean absolute luma gradient over the ROI: a cheap proxy for how busy the
   * texture is, sampled on a stride so it stays O(1)-ish on large crops. */
  function measureTextureFrequency(pixels, width, height) {
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 40000)));
    let total = 0, count = 0;
    for (let y = 1; y < height - 1; y += step) {
      for (let x = 1; x < width - 1; x += step) {
        const p = (y * width + x) * 4;
        const l = CAF.luma(pixels, p);
        total += Math.abs(l - CAF.luma(pixels, p + 4)) + Math.abs(l - CAF.luma(pixels, p + width * 4));
        count += 2;
      }
    }
    return count ? total / count : 12;
  }

  function pick(value, fallback) {
    return (value === undefined || value === null || value === 'auto') ? fallback : value;
  }

  /* `measured` carries what only the caller can know: the pixels, the hole size,
   * and the full image's long edge (which is not the ROI's). */
  function resolve(raw, measured) {
    const options = raw || {};
    const m = measured || {};
    const width = Math.max(1, m.width | 0);
    const height = Math.max(1, m.height | 0);
    const holeArea = Math.max(0, m.holeArea | 0);
    const imageLongEdge = Math.max(width, height, m.imageLongEdge | 0);

    const quality = QUALITIES.includes(options.quality) ? options.quality : 'balanced';
    const preset = PRESETS[quality];

    const textureFrequency = Number.isFinite(m.textureFrequency)
      ? m.textureFrequency
      : (m.pixels ? measureTextureFrequency(m.pixels, width, height) : 12);

    const patchSize = clamp(pick(options.patchSize, autoPatchSize(holeArea, width * height, textureFrequency)) | 1, 3, 21);
    const maxLevels = clamp(pick(options.maxPyramidLevels, preset.maxLevels), 1, 6);
    const pyramidLevels = clamp(pick(options.pyramidLevels, autoPyramidLevels(width, height, holeArea, maxLevels)), 1, 6);
    const iterations = clamp(pick(options.iterations, preset.iterations), 1, 32);
    const searchRadius = clamp(pick(options.searchRadius, autoSearchRadius(width, height, preset.searchScale)), 2, 8192);

    const rotationName = pick(options.rotationAdaptation, preset.rotationAdaptation);
    const scaleName = pick(options.scaleAdaptation, preset.scaleAdaptation);

    return {
      quality,
      seed: (pick(options.seed, 1337) >>> 0) || 1337,
      patchSize,
      patchRadius: patchSize >> 1,
      iterations,
      pyramidLevels,
      searchRadius,
      /* One pass fewer past HUGE_HOLE, floored at one. Applied to every preset
       * so their ordering survives — High still refines more than Balanced,
       * which still refines more than Preview — while none of them runs away. */
      passes: clamp(pick(options.passes,
        holeArea > HUGE_HOLE ? Math.max(1, preset.passes - 1) : preset.passes), 1, 8),
      roiScale: Math.max(0.25, Number(pick(options.roiScale, preset.roiScale)) || 1),

      // Scoring weights (§9). They are relative; patch-distance normalises.
      colorWeight: Math.max(0, Number(pick(options.colorWeight, 1)) || 0),
      gradientWeight: Math.max(0, Number(pick(options.gradientWeight, 0.55)) || 0),
      structureWeight: Math.max(0, Number(pick(options.structureWeight, 0.45)) || 0),
      coherenceWeight: Math.max(0, Number(pick(options.coherenceWeight, 0.6)) || 0),
      coherenceRef: Math.max(0.5, Number(pick(options.coherenceRef, 6)) || 6),
      localityWeight: Math.max(0, Number(pick(options.localityWeight, 0.12)) || 0),

      colorAdaptation: clamp(Number(pick(options.colorAdaptation, preset.colorAdaptation)) || 0, 0, 1),
      rotationAdaptation: rotationName,
      rotationLevel: ROTATION_LEVELS[rotationName] === undefined ? 0 : ROTATION_LEVELS[rotationName],
      scaleAdaptation: scaleName,
      scaleLevel: SCALE_LEVELS[scaleName] === undefined ? 0 : SCALE_LEVELS[scaleName],
      mirror: options.mirror === undefined ? preset.mirror : !!options.mirror,
      voteRadiusScale: preset.voteRadiusScale,
      patchStride: clamp(pick(options.patchStride, preset.patchStride) | 0, 1, 4),

      maskExpansion: clamp(pick(options.maskExpansion, autoMaskExpansion(imageLongEdge)) | 0, 0, 64),
      forbiddenDilation: clamp(pick(options.forbiddenDilation, autoForbiddenDilation(imageLongEdge, patchSize)) | 0, 0, 64),
      edgeBlend: clamp(pick(options.edgeBlend, autoEdgeBlend(patchSize, holeArea)) | 0, 0, 64),

      despeckle: options.despeckle === undefined ? true : !!options.despeckle,
      coherentFinish: !!options.coherentFinish,
      debug: !!options.debug,
      textureFrequency,
      imageLongEdge,
    };
  }

  CAF.QUALITIES = QUALITIES;
  CAF.PRESETS = PRESETS;
  CAF.resolveOptions = resolve;
  CAF.autoPatchSize = autoPatchSize;
  CAF.autoPyramidLevels = autoPyramidLevels;
  CAF.autoEdgeBlend = autoEdgeBlend;
  CAF.autoForbiddenDilation = autoForbiddenDilation;
  CAF.measureTextureFrequency = measureTextureFrequency;
})(typeof self !== 'undefined' ? self : globalThis);
