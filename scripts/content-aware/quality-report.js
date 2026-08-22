'use strict';
/* Quality failure detection (§34).
 *
 * The engine has to be able to say "this came out badly" rather than presenting
 * every result as finished. §34 names the symptoms to look for — very high patch
 * costs, few valid matching patches, large unsupported masked areas, repetitive
 * artefacts, boundary discontinuities — and each has a metric here.
 *
 * The battery is ported from the previous implementation's self-audit, minus the
 * terms that only meant something when scoring against a generated guide, plus
 * the ones only an exemplar engine can report: what the matches actually cost,
 * how much legal source there was, and how many distinct sources got used.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp, medianMad, percentile } = CAF;

  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  /* Local gradient energy: a scalar standing in for "how busy is the texture
   * here", used to check the fill kept the surroundings' grain. */
  function textureAt(pixels, width, height, x, y, radius) {
    let sum = 0, n = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const yy = y + dy;
      if (yy < 1 || yy >= height - 1) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = x + dx;
        if (xx < 1 || xx >= width - 1) continue;
        const p = (yy * width + xx) * 4;
        const l = CAF.luma(pixels, p);
        sum += Math.abs(l - CAF.luma(pixels, p + 4)) + Math.abs(l - CAF.luma(pixels, p + width * 4));
        n += 2;
      }
    }
    return n ? sum / n : 0;
  }

  const TEXTURE_RADIUS = 2;

  /* Robust description of the known content around the hole. Median and MAD
   * rather than mean and standard deviation, because the ring inevitably picks
   * up a few pixels of whatever was being removed.
   *
   * The ring is held back by the texture window's own radius. Sampled right up
   * against the mask, the 5x5 window used for texture reaches into the hole and
   * measures the object being erased: on the reference sky that reported a
   * boundary texture of 12.9 against a true 1.04, which both destroyed the
   * texture-retention metric and inflated the allowance that internal seam
   * detection subtracts — so genuine seams scored a flat zero. */
  function boundaryProfile(pixels, mask, width, height, band) {
    const r = band || 3;
    const inner = TEXTURE_RADIUS;
    const outer = TEXTURE_RADIUS + r;

    /* The ring hugs the hole, so everything here is confined to the hole's
     * bounding box plus the ring width. On a megapixel region with a small
     * selection, scanning the whole region instead — and running the distance
     * transform across it — was the single largest cost in the whole fill. */
    const bbox = CAF.maskBounds(mask, width, height);
    const pad = outer + 2;
    const x0 = bbox ? Math.max(0, bbox.x0 - pad) : 0;
    const y0 = bbox ? Math.max(0, bbox.y0 - pad) : 0;
    const x1 = bbox ? Math.min(width, bbox.x1 + pad) : width;
    const y1 = bbox ? Math.min(height, bbox.y1 + pad) : height;
    const bw = x1 - x0, bh = y1 - y0;

    const sub = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) {
      const src = (y0 + y) * width + x0;
      for (let x = 0; x < bw; x++) sub[y * bw + x] = mask[src + x] ? 1 : 0;
    }
    // One distance field, thresholded twice, over the sub-rect only.
    const distance = CAF.distanceField(sub, bw, bh, outer + 1);

    const R = [], G = [], B = [], L = [], TEX = [];
    const step = Math.max(1, Math.round(Math.sqrt(bw * bh / 60000)));
    for (let sy = 0; sy < bh; sy++) {
      const y = y0 + sy;
      for (let sx = 0; sx < bw; sx++) {
        const si = sy * bw + sx;
        const d = distance[si];
        if (sub[si] || d <= inner || d > outer) continue;
        const x = x0 + sx;
        if ((x + y) % step) continue;
        const i = y * width + x;
        const p = i * 4;
        R.push(pixels[p]); G.push(pixels[p + 1]); B.push(pixels[p + 2]);
        L.push(CAF.luma(pixels, p));
        TEX.push(textureAt(pixels, width, height, x, y, 2));
      }
    }
    if (!L.length) {
      return { empty: true, r: { median: 128, mad: 32 }, g: { median: 128, mad: 32 }, b: { median: 128, mad: 32 }, luma: { median: 128, mad: 32, spread: 32 }, texture: { median: 8, q90: 16 } };
    }
    const luma = medianMad(L, 128);
    return {
      empty: false,
      r: medianMad(R, 128),
      g: medianMad(G, 128),
      b: medianMad(B, 128),
      luma: { median: luma.median, mad: luma.mad, spread: Math.max(6, luma.mad * 1.6) },
      texture: { median: CAF.median(TEX, 8), q90: percentile(TEX, 0.9, 16) },
      contrast: neighbourContrast(pixels, mask, width, distance, sub, bw, bh, x0, y0, outer),
      samples: L.length,
    };
  }

  /* Mean RGB distance between adjacent known pixels near the hole: how big a
   * step this part of the image *already* takes from one pixel to the next.
   *
   * A boundary seam has to be judged against it. Brickwork with hard mortar
   * lines produces a large step wherever the hole edge crosses one, and that is
   * the photograph, not a defect — measured on the reference facade a perfectly
   * good fill scored a raw boundary seam of 12.4, which a fixed threshold reads
   * as a failure while a smooth wall at the same score would genuinely be one. */
  function neighbourContrast(pixels, mask, width, distance, sub, bw, bh, x0, y0, band) {
    let sum = 0, n = 0;
    for (let sy = 0; sy < bh - 1; sy++) {
      for (let sx = 0; sx < bw - 1; sx++) {
        const si = sy * bw + sx;
        if (sub[si] || distance[si] > band) continue;
        const x = x0 + sx, y = y0 + sy;
        const i = y * width + x;
        const right = i + 1, down = i + width;
        if (!mask[right]) {
          sum += Math.hypot(pixels[i * 4] - pixels[right * 4],
            pixels[i * 4 + 1] - pixels[right * 4 + 1],
            pixels[i * 4 + 2] - pixels[right * 4 + 2]);
          n++;
        }
        if (!mask[down]) {
          sum += Math.hypot(pixels[i * 4] - pixels[down * 4],
            pixels[i * 4 + 1] - pixels[down * 4 + 1],
            pixels[i * 4 + 2] - pixels[down * 4 + 2]);
          n++;
        }
      }
    }
    return n ? sum / n : 0;
  }

  /* How far one output pixel sits outside the boundary's colour distribution,
   * measured in robust standard deviations. */
  function profileDistance(pixels, p, profile) {
    const dr = Math.abs(pixels[p] - profile.r.median) / Math.max(6, profile.r.mad);
    const dg = Math.abs(pixels[p + 1] - profile.g.median) / Math.max(6, profile.g.mad);
    const db = Math.abs(pixels[p + 2] - profile.b.median) / Math.max(6, profile.b.mad);
    return (dr + dg + db) / 3;
  }

  function evaluate(state) {
    const {
      pixels, original, mask, nnf, width, height, hole,
      sourceCount, sourceRelaxed, options,
    } = state;

    const profile = boundaryProfile(original, mask, width, height, 3);
    const holeCount = hole.length || 1;

    let seam = 0, seamN = 0;
    let coherent = 0, coherentN = 0;
    let missing = 0;
    let fillTexture = 0, textureN = 0;
    let fillLuma = 0;
    let outliers = 0, profileError = 0;
    let internalSeam = 0, internalSeamN = 0;
    let internalNeighbors = 0, regionBoundaries = 0;
    const internalSamples = [];
    const continuousSamples = [];
    let continuousSum = 0, continuousN = 0;
    const costs = [];
    const rowSeam = new Float32Array(height), rowCount = new Uint32Array(height);
    const colSeam = new Float32Array(width), colCount = new Uint32Array(width);
    const usedSources = new Set();

    /* Every metric here is a mean, a ratio or a percentile, so they converge
     * long before the whole hole has been visited — and each visit runs a 5x5
     * texture window plus four neighbour tests. Left unstrided this pass was
     * measured at 38% of a fill's entire runtime, more than the matching it was
     * scoring. Twenty thousand samples is far past the point where any of these
     * numbers move. */
    const METRIC_SAMPLE_TARGET = 20000;
    const step = Math.max(1, Math.floor(holeCount / METRIC_SAMPLE_TARGET));
    let sampled = 0;

    /* How large a step between neighbouring pixels this image takes on its own.
     *
     * A difference smaller than that is the photograph, not a seam. Both terms
     * matter: `contrast` is the true adjacent-pixel step, which is what an
     * internal seam is measured in, while `texture.q90` is a 5x5-smoothed
     * gradient and badly understates it on grainy content — measured on a
     * film-grain plate whose neighbouring pixels differ by 35 on average, the
     * smoothed figure put the allowance at 28 and every patch of ordinary grain
     * scored as a seam, rejecting a fill that had removed its object cleanly and
     * kept 90% of the surrounding texture. */
    const internalAllowance = Math.max(9, profile.contrast * 1.4, profile.texture.q90 * 1.4);

    for (let hk = 0; hk < hole.length; hk += step) {
      const i = hole[hk];
      const x = i % width, y = (i / width) | 0, p = i * 4;
      sampled++;

      if (nnf.x[i] < 0) missing++;
      else {
        usedSources.add(nnf.y[i] * width + nnf.x[i]);
        if (Number.isFinite(nnf.d[i])) costs.push(nnf.d[i]);
      }

      fillLuma += CAF.luma(pixels, p);
      fillTexture += textureAt(pixels, width, height, x, y, 2);
      textureN++;

      const colorError = profileDistance(pixels, p, profile);
      profileError += Math.min(6, colorError);
      if (colorError > 2.2) outliers++;

      for (let t = 0; t < 4; t++) {
        const nx = x + DIRS[t][0], ny = y + DIRS[t][1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (!mask[q]) {
          // §34: boundary discontinuity, measured against the untouched original.
          const qp = q * 4;
          seam += Math.hypot(pixels[p] - original[qp], pixels[p + 1] - original[qp + 1], pixels[p + 2] - original[qp + 2]);
          seamN++;
          continue;
        }
        if (nnf.x[q] < 0 || nnf.x[i] < 0) continue;
        coherentN++;
        const offsetDelta = Math.hypot((nnf.x[i] - x) - (nnf.x[q] - nx), (nnf.y[i] - y) - (nnf.y[q] - ny));
        if (offsetDelta <= 2) coherent++;
        // Each unordered pair once.
        if (DIRS[t][0] < 0 || DIRS[t][1] < 0) continue;
        internalNeighbors++;
        const qp = q * 4;
        const difference = Math.hypot(pixels[qp] - pixels[p], pixels[qp + 1] - pixels[p + 1], pixels[qp + 2] - pixels[p + 2]);

        /* Pairs that came from the same place tell us what a step between
         * neighbours looks like when there is definitively no seam. Pairs that
         * came from different places are compared against exactly that. */
        if (offsetDelta <= 2) {
          continuousSum += difference;
          continuousN++;
          if (continuousSamples.length < 120000) continuousSamples.push(difference);
          continue;
        }
        regionBoundaries++;
        const artifact = Math.max(0, difference - internalAllowance);
        internalSeam += artifact;
        internalSeamN++;
        if (internalSamples.length < 120000) internalSamples.push(artifact);
        if (DIRS[t][0] === 0) { const row = Math.min(y, ny); rowSeam[row] += artifact; rowCount[row]++; }
        else { const col = Math.min(x, nx); colSeam[col] += artifact; colCount[col]++; }
      }
    }

    const fillF = textureN ? fillTexture / textureN : 0;
    const knownF = profile.texture.median;
    /* Symmetric ratio in 0..1: 1 means the fill carries the same amount of
     * high-frequency detail as the ring around it, in either direction. The
     * denominator must not be floored at 1 — on smooth content both sides are
     * well below 1 and a floor reports a faithful fill as total texture loss. */
    const textureFrequencyRetention = Math.min(fillF, knownF) / Math.max(1e-3, Math.max(fillF, knownF));
    const fillLumaMean = sampled ? fillLuma / sampled : profile.luma.median;

    /* A straight line of seam energy across a whole row or column is the
     * signature of a splice — a rectangle of somewhere else pasted in — which
     * reads far worse than the same energy scattered. */
    /* The continuous pairs, put through the identical allowance, are the
     * no-seam control for both the mean and the tail. */
    let continuousExcessSum = 0;
    for (let i = 0; i < continuousSamples.length; i++) continuousExcessSum += Math.max(0, continuousSamples[i] - internalAllowance);
    const continuousExcess = continuousSamples.length ? continuousExcessSum / continuousSamples.length : 0;
    const continuousExcessP95 = percentile(
      continuousSamples.map(v => Math.max(0, v - internalAllowance)), 0.95, 0);

    let straightSeamMean = 0;
    for (let y = 0; y < height; y++) if (rowCount[y] >= 4) straightSeamMean = Math.max(straightSeamMean, rowSeam[y] / rowCount[y] - continuousExcess);
    for (let x = 0; x < width; x++) if (colCount[x] >= 4) straightSeamMean = Math.max(straightSeamMean, colSeam[x] / colCount[x] - continuousExcess);
    straightSeamMean = Math.max(0, straightSeamMean);

    const metrics = {
      seamMean: seamN ? seam / seamN : 0,
      boundaryContrast: profile.contrast,
      coherence: coherentN ? coherent / coherentN : 0,
      missingRatio: sampled ? missing / sampled : 1,
      textureFrequencyRetention,
      fillTextureMean: fillF,
      boundaryTextureMedian: knownF,
      repeatedPatchDensity: sampled ? 1 - usedSources.size / sampled : 1,
      boundaryLuma: profile.luma.median,
      fillLuma: fillLumaMean,
      boundaryToneShift: Math.abs(fillLumaMean - profile.luma.median),
      boundaryOutlierRatio: sampled ? outliers / sampled : 1,
      localProfileError: sampled ? profileError / sampled : 6,
      /* Seam strength relative to what the same reconstruction does where there
       * is no seam at all. Self-normalising, so grain, noise and busy texture
       * cancel out of both sides instead of being charged to the fill. */
      internalSeamMean: Math.max(0, (internalSeamN ? internalSeam / internalSeamN : 0) - continuousExcess),
      internalSeamP95: Math.max(0, percentile(internalSamples, 0.95, 0) - continuousExcessP95),
      internalSeamRaw: internalSeamN ? internalSeam / internalSeamN : 0,
      straightSeamMean,
      sourceRegionBoundaryRatio: internalNeighbors ? regionBoundaries / internalNeighbors : 0,
      // §34: "very high patch costs" and "few valid matching patches".
      patchCostMean: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 0,
      patchCostP95: percentile(costs, 0.95, 0),
      sourceCoverage: CAF.samplingArea.coverageRatio(sourceCount, holeCount),
      sourceFilterRelaxed: !!sourceRelaxed,
    };

    /* Every constant below is calibrated against a fixed panel of good and
     * deliberately-bad fills over the five reference scenes (see
     * scripts/test-content-aware-scenes.mjs). The good fills clustered at
     * patchCostMean <= 0.22, localProfileError <= 1.7, boundaryOutlierRatio
     * <= 0.32, seamMean <= 8.6, straightSeamMean <= 2.1, internalSeamP95 = 0;
     * the bad ones — a hole filled from an incompatible region, and a hole whose
     * sampling area was restricted to the wrong side of a hard tonal split — at
     * patchCostMean >= 2.8, localProfileError >= 5.2, boundaryOutlierRatio
     * >= 0.91, seamMean >= 15, straightSeamMean >= 9.3, internalSeamP95 >= 6.5.
     *
     * Thresholds sit inside those gaps with margin on both sides. They are
     * deliberately nearer the bad cluster: a false rejection hides a usable
     * result, which is worse than flagging a mediocre one. */
    /* Excess over the local contrast the photograph already has. */
    metrics.seamExcess = Math.max(0, metrics.seamMean - metrics.boundaryContrast);

    const confidence = clamp(1
      // §34's "very high patch costs" — by far the strongest single signal.
      - metrics.patchCostMean / 3
      /* Offset by the value a *correct* fill already scores. localProfileError
       * is a mean absolute deviation in robust-sigma units, so even a perfect
       * reconstruction of textured content lands near 0.8; charging from zero
       * penalises grass for being grass. */
      - Math.max(0, metrics.localProfileError - 0.9) / 5
      - metrics.seamExcess / 60
      - metrics.internalSeamMean / 12
      - metrics.straightSeamMean / 30
      - Math.max(0, 0.4 - metrics.coherence)
      - Math.max(0, 0.5 - metrics.textureFrequencyRetention) * 0.5
      - metrics.missingRatio * 2
      - Math.max(0, 1 - metrics.sourceCoverage / 3) * 0.2, 0, 1);

    const toneLimit = Math.max(46, profile.luma.spread * 1.45);
    const unsafeReasons = [];
    if (metrics.missingRatio > 0.001) unsafeReasons.push('part of the region had no usable source');
    if (metrics.patchCostMean > 1.2) unsafeReasons.push('no good matches were found for this region');
    if (metrics.seamExcess > 9) unsafeReasons.push('visible boundary seam');
    if (metrics.boundaryOutlierRatio > 0.7) unsafeReasons.push('fill colors do not match the surrounding surface');
    if (metrics.boundaryToneShift > toneLimit && metrics.boundaryOutlierRatio > 0.5) unsafeReasons.push('catastrophic boundary tone shift');
    /* A 95th percentile climbs with sample count, so a threshold tuned on a
     * small reference hole rejects a good fill on a larger one purely for
     * having more neighbour pairs: the same grass scene scored 1.3 at 300x220
     * and 5.7 at 1920x1080 with identical quality. The gap to a genuinely bad
     * fill (12.9 and up) is wide enough to sit well clear of both. */
    /* A backstop. Once the no-seam control is subtracted, a diffuse mismatch
     * mostly shows up in straightSeamMean below — a splice concentrates its
     * energy along one row or column, while the mean over every discontinuous
     * pair dilutes it. This catches the pathological case where it does not. */
    if (metrics.internalSeamP95 > 12 && metrics.internalSeamMean > 2) unsafeReasons.push('visible seam between source regions');
    /* The effective internal-seam detector. Measured across the reference panel:
     * good fills score 0.0-2.9, a good fill on a pure-noise plate reaches 6.1,
     * and a fill forced from an incompatible region scores 10.1-17.9. */
    if (metrics.straightSeamMean > 8) unsafeReasons.push('straight internal splice');
    if (metrics.localProfileError > 3.2) unsafeReasons.push('fill texture does not match the local boundary');

    /* Flagged, not rejected: worth telling the user about, but the result may
     * still be the best available and is theirs to accept. */
    const flaggedReasons = [];
    if (metrics.sourceCoverage < 3) flaggedReasons.push('little source material outside the selection');
    if (metrics.sourceFilterRelaxed) flaggedReasons.push('sampling area was too small and was widened');
    if (metrics.repeatedPatchDensity > 0.9) flaggedReasons.push('the same few patches were reused heavily');
    if (metrics.coherence < 0.35) flaggedReasons.push('reconstruction is fragmented');
    if (metrics.textureFrequencyRetention < 0.35) flaggedReasons.push('fill is smoother than its surroundings');

    const hardRejected = unsafeReasons.length > 0;
    /* Deliberately built from the resolution-stable measures. Internal-seam
     * mean and percentile both climb with the number of neighbour pairs, so a
     * flag keyed to them marks a good fill on a big photo as doubtful purely
     * for being big; they earn their place in the rejection rules, where the
     * margin to a genuinely bad fill is wide, not in a borderline flag. */
    const lowConfidence = hardRejected
      || confidence < 0.55
      || metrics.patchCostMean > 0.6
      || metrics.seamExcess > 6
      || metrics.localProfileError > 2.2
      || metrics.boundaryOutlierRatio > 0.5
      || metrics.coherence < 0.35;

    return {
      metrics, confidence, lowConfidence, hardRejected,
      unsafeReasons, flaggedReasons, profile,
      status: hardRejected ? 'REJECTED' : lowConfidence ? 'LOW_CONFIDENCE' : 'OK',
    };
  }

  CAF.qualityReport = {
    textureAt,
    boundaryProfile,
    profileDistance,
    evaluate,
  };
})(typeof self !== 'undefined' ? self : globalThis);
