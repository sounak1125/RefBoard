'use strict';
/* The public entry point (§31).
 *
 *   fill(image, fillMask, samplingMask, options) -> ContentAwareResult
 *
 * Pipeline (§2):
 *   mask preprocessing -> sampling area -> ROI -> classify
 *     tiny/thin  -> Telea fast marching
 *     otherwise  -> pyramid -> shift labelling seed -> PatchMatch per level
 *                   -> voting (annealed) -> coherent finish -> colour adapt
 *                   -> boundary-band blend
 *   -> composite back into the untouched full-resolution image
 *
 * Pixels outside the fill mask are never written (§22). The ROI is copied out,
 * solved, and copied back only where the mask says so.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp } = CAF;

  const STAGES = {
    prepare: 'Preparing image',
    pyramid: 'Building pyramid',
    blend: 'Blending',
    complete: 'Complete',
  };

  class Cancelled extends Error {
    constructor() { super('Content-aware fill cancelled'); this.name = 'Cancelled'; }
  }

  /* §4. The margin adapts to the hole: a small object needs a modest ring of
   * context, a large erase needs somewhere to find enough material. */
  function computeRoi(bounds, width, height, options) {
    const longEdge = Math.max(bounds.width, bounds.height);
    const base = clamp(Math.round(longEdge * 2), 100, 500);
    /* Wide enough that mask expansion, the forbidden-sampling dilation and a
     * whole patch all still fit inside the crop — otherwise the region would
     * clip the very context it was cut to preserve. */
    const clearance = options.maskExpansion + options.forbiddenDilation + options.patchSize + 4;
    const margin = Math.max(options.patchSize * 4, clearance, Math.round(base * options.roiScale));
    const x0 = Math.max(0, bounds.x0 - margin);
    const y0 = Math.max(0, bounds.y0 - margin);
    const x1 = Math.min(width, bounds.x1 + margin);
    const y1 = Math.min(height, bounds.y1 + margin);
    return { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0, margin };
  }

  /* Bounding box of the caller's mask, read straight off the input in one pass.
   *
   * This exists so the region of interest can be chosen *before* anything is
   * allocated. Running mask preprocessing, sampling-area construction and the
   * quality report over the whole frame first is what §4 exists to prevent: on
   * a 1920x1080 photo with a small selection those full-frame passes cost 1.9s
   * against roughly 70ms for the same work confined to the region. */
  function rawMaskBounds(source, width, height) {
    const total = width * height;
    const rgba = source.length === total * 4;
    if (!rgba && source.length !== total) {
      throw new Error(`Mask length ${source.length} matches neither ${total} nor ${total * 4}`);
    }
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const i = row + x;
        if (!(rgba ? source[i * 4] : source[i])) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return x1 < x0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1, width: x1 + 1 - x0, height: y1 + 1 - y0 };
  }

  function cropRgba(pixels, width, roi) {
    const out = new Uint8ClampedArray(roi.width * roi.height * 4);
    for (let y = 0; y < roi.height; y++) {
      const src = ((roi.y0 + y) * width + roi.x0) * 4;
      out.set(pixels.subarray(src, src + roi.width * 4), y * roi.width * 4);
    }
    return out;
  }

  /* Crops the caller's mask into a single-channel plane in ROI space. */
  function cropRawMask(source, width, height, roi) {
    const rgba = source.length === width * height * 4;
    const out = new Uint8Array(roi.width * roi.height);
    for (let y = 0; y < roi.height; y++) {
      const src = (roi.y0 + y) * width + roi.x0;
      const dst = y * roi.width;
      for (let x = 0; x < roi.width; x++) {
        const i = src + x;
        out[dst + x] = rgba ? source[i * 4] : (source[i] <= 1 ? (source[i] ? 255 : 0) : source[i]);
      }
    }
    return out;
  }

  function cropPlane(plane, width, roi, Ctor) {
    const out = new Ctor(roi.width * roi.height);
    for (let y = 0; y < roi.height; y++) {
      const src = (roi.y0 + y) * width + roi.x0;
      out.set(plane.subarray(src, src + roi.width), y * roi.width);
    }
    return out;
  }

  /* Per-level solve parameters (§12): coarse levels get more iterations and a
   * search radius spanning the whole level, fine levels refine locally. */
  function levelPlan(levels, options) {
    const plan = [];
    for (let li = levels.length - 1; li >= 0; li--) {
      const lv = levels[li];
      const coarsest = li === levels.length - 1;
      const finest = li === 0;
      const radius = Math.max(1, Math.min(options.patchRadius, Math.min(lv.width, lv.height) >> 3));
      const iterations = coarsest ? options.iterations + 2
        : finest ? options.iterations
          : Math.max(3, options.iterations - 1);
      const search = coarsest
        ? Math.max(lv.width, lv.height)
        : Math.max(8, Math.min(options.searchRadius, Math.max(lv.width, lv.height) >> 2));
      // Depth from the coarsest level drives the vote annealing: wide early so
      // hypotheses can blend, narrow late so the result is decisive.
      const depth = levels.length - 1 - li;
      plan.push({
        li, level: lv, radius, iterations, search, finest, coarsest,
        sharpness: Math.pow(2, depth),
        passes: finest ? options.passes : 1,
      });
    }
    return plan;
  }

  function fill(image, fillMask, samplingMask, rawOptions) {
    const started = Date.now();
    const width = image.width | 0;
    const height = image.height | 0;
    const pixels = image.data || image.pixels;
    if (!pixels || pixels.length !== width * height * 4) {
      throw new Error(`Image data is ${pixels ? pixels.length : 0} bytes, expected ${width * height * 4}`);
    }
    const opts = rawOptions || {};
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : () => false;
    const checkCancel = () => { if (isCancelled()) throw new Cancelled(); };
    const report = (stage, percent) => { if (onProgress) onProgress(stage, clamp(percent, 0, 1)); };

    report(STAGES.prepare, 0.01);

    /* --- region of interest, chosen first (§4) ---------------------------
     *
     * Everything below this point works in ROI coordinates. Cropping before the
     * mask is preprocessed rather than after is the whole point: mask
     * expansion, connected components, the sampling area, and the quality
     * report are all several full-frame distance transforms, and on a 1920x1080
     * photo with a small selection they cost about 1.9s when run over the frame
     * against roughly 70ms confined to the region. */
    const rawBounds = rawMaskBounds(fillMask, width, height);
    if (!rawBounds) throw new Error('The fill mask is empty');

    // A provisional resolve, only to size the region; the exact hole area is
    // not known until the mask has been preprocessed inside it.
    const provisional = CAF.resolveOptions(opts, {
      width, height, holeArea: rawBounds.width * rawBounds.height, pixels,
      imageLongEdge: Math.max(width, height),
    });
    let roi = computeRoi(rawBounds, width, height, provisional);

    let roiPixels = cropRgba(pixels, width, roi);
    let roiRawMask = cropRawMask(fillMask, width, height, roi);
    let roiSamplingMask = samplingMask ? cropRawMask(samplingMask, width, height, roi) : null;

    let options = CAF.resolveOptions(opts, {
      width: roi.width, height: roi.height, holeArea: 0, pixels: roiPixels,
      imageLongEdge: Math.max(width, height),
    });
    let maskInfo = CAF.maskProcessor.prepare(roiRawMask, roi.width, roi.height, options);
    // Now that the hole is measured, resolve again so patch size and blend width
    // reflect it rather than a guess.
    options = CAF.resolveOptions(opts, {
      width: roi.width, height: roi.height, holeArea: maskInfo.area, pixels: roiPixels,
      imageLongEdge: Math.max(width, height), textureFrequency: options.textureFrequency,
    });

    const debug = CAF.debugCapture.create(options.debug);
    debug.rgba('original', roiPixels, roi.width, roi.height);
    debug.mask('fill-mask', maskInfo.fill, roi.width, roi.height);
    debug.note('maskExpansion', maskInfo.expansion);
    debug.note('components', maskInfo.components);
    debug.note('specksRemoved', maskInfo.speckRemoved);

    // --- sampling area ----------------------------------------------------
    let sampling = CAF.samplingArea.build(maskInfo.fill, roiPixels, roi.width, roi.height, options, roiSamplingMask);

    /* Too little legal source inside the region means the engine would copy the
     * same few patches over and over. Widening to the whole frame costs time but
     * is the difference between a believable fill and visible tiling, so it is
     * worth one retry — and after it, everything downstream simply runs at full
     * frame because the region *is* the frame. */
    if (sampling.count < maskInfo.area * 4 && (roi.width < width || roi.height < height)) {
      roi = { x0: 0, y0: 0, x1: width, y1: height, width, height, margin: Infinity };
      roiPixels = cropRgba(pixels, width, roi);
      roiRawMask = cropRawMask(fillMask, width, height, roi);
      roiSamplingMask = samplingMask ? cropRawMask(samplingMask, width, height, roi) : null;
      maskInfo = CAF.maskProcessor.prepare(roiRawMask, roi.width, roi.height, options);
      sampling = CAF.samplingArea.build(maskInfo.fill, roiPixels, roi.width, roi.height, options, roiSamplingMask);
    }

    debug.mask('sampling-mask', sampling.allowed, roi.width, roi.height);
    debug.mask('forbidden-mask', sampling.forbidden, roi.width, roi.height);
    debug.note('roi', { x0: roi.x0, y0: roi.y0, width: roi.width, height: roi.height });

    if (!sampling.count) {
      throw new Error('There is no usable source material outside the selection');
    }

    checkCancel();

    // The full-resolution result; only masked pixels are ever written into it.
    const result = new Uint8ClampedArray(pixels);

    // --- tiny holes, scratches, thin structures (§5) -----------------------
    if (maskInfo.algorithm === 'telea') {
      report(STAGES.blend, 0.6);
      const patched = new Uint8ClampedArray(roiPixels);
      CAF.inpaintFallback.inpaint(patched, maskInfo.fill, roi.width, roi.height, {
        radius: Math.max(3, options.patchRadius + 1),
        allowed: sampling.allowed,
      });
      report(STAGES.complete, 1);
      return finish({
        result, pixels, roiPixels, roiResult: patched, maskInfo, sampling,
        width, height, roi, options, debug, started,
        algorithmUsed: 'telea', nnf: null, levels: 1,
      });
    }

    const roiMask = maskInfo.fill;
    const roiAllowed = sampling.allowed;
    const roiHoleCount = maskInfo.area;
    if (!roiHoleCount) throw new Error('The fill region fell outside the region of interest');

    // --- pyramid (§12) ----------------------------------------------------
    report(STAGES.pyramid, 0.05);
    const levels = CAF.imagePyramid.build(roiPixels, roiMask, roiAllowed, roi.width, roi.height, options.pyramidLevels);
    const plan = levelPlan(levels, options);
    debug.note('levels', levels.length);
    checkCancel();

    const random = CAF.makeRandom(options.seed);
    let previous = null;
    let finalNnf = null;
    let finalWork = null;
    let finalLevel = null;
    let labelSeeded = false;

    for (let step = 0; step < plan.length; step++) {
      const { level, radius, iterations, search, finest, coarsest, sharpness, passes, li } = plan[step];
      const lw = level.width, lh = level.height;
      report(`Level ${step + 1}/${plan.length}`, 0.08 + 0.82 * (step / plan.length));
      checkCancel();

      const work = new Uint8ClampedArray(level.pixels);
      if (previous) {
        CAF.imagePyramid.upsampleInto(previous.work, previous.width, previous.height, work, level.mask, lw, lh);
      }

      const centers = CAF.samplingArea.buildValidCenters(level.allowed, lw, lh, radius);
      if (!centers.count) {
        // Nothing at this scale can host a full patch. Skip rather than fail;
        // a finer level with a smaller radius usually can.
        previous = { work, width: lw, height: lh };
        continue;
      }

      const hole = [];
      for (let i = 0; i < lw * lh; i++) if (level.mask[i]) hole.push(i);
      const holeArr = Int32Array.from(hole);
      const { order, depth } = CAF.confidence.fillOrder(level.mask, lw, lh);

      const conf = CAF.confidence.create(level.mask, lw, lh);
      let maxDepth = 0;
      for (let k = 0; k < order.length; k++) if (depth[order[k]] > maxDepth) maxDepth = depth[order[k]];
      CAF.confidence.seedFromDepth(conf, level.mask, depth, maxDepth);

      const nnf = CAF.nnf.create(lw, lh);
      const ctx0 = { width: lw, height: lh, radius };

      /* The coarsest level is seeded from shift labelling rather than noise, so
       * PatchMatch starts on a layout already made of large contiguous pieces of
       * the photograph and spends its iterations refining instead of
       * discovering. */
      if (coarsest || !previous) {
        let seeded = false;
        const bounds = CAF.maskBounds(level.mask, lw, lh);
        if (bounds) {
          try {
            const solved = CAF.shiftLabeling.solve(lw, lh, work, level.mask, level.allowed, holeArr, bounds);
            if (solved) {
              CAF.nnf.seedFromShifts(nnf, holeArr, solved.labels, solved.shifts, centers, lw, lh, random);
              debug.note('shiftCandidates', solved.shifts.length);
              seeded = true;
              labelSeeded = true;
            }
          } catch (err) {
            // Labelling is an optimisation, never a requirement.
            debug.note('shiftLabelingError', String(err && err.message || err));
          }
        }
        if (!seeded) CAF.nnf.randomInit(nnf, holeArr, centers, random);

        /* Materialise the seed immediately, so the hole holds real photograph
         * rather than whatever the pyramid's downsample left there.
         *
         * This matters more than it looks. Patch distance weights each target
         * pixel by its confidence, and confidence inside the hole starts non-zero
         * near the boundary — so an unmaterialised hole lets the placeholder vote
         * on which source wins. For canvas extension the placeholder is
         * transparent black, which quietly biases every match toward dark
         * sources: the extended ground came out right while the extended sky came
         * back grey. Finer levels already get this from upsampleInto. */
        CAF.patchVoting.coherentCopy(ctx0, {
          nnf, hole: holeArr, source: work.slice(), out: work, mask: level.mask, adapt: null,
        });
      } else {
        CAF.nnf.upsample(previous.nnf, previous.width, previous.height, nnf, lw, lh, holeArr, centers, random);
      }
      checkCancel();

      const spatial = CAF.patchVoting.buildSpatialWeights(radius);
      const ctx = ctx0;
      let voteInfo = null;
      let lastAnalysis = null;

      /* Vote accumulators, allocated once per level and reused across its
       * passes (§29). At full resolution on a large erase these come to roughly
       * three quarters of a gigabyte between them; allocating a fresh set per
       * pass hands all of it straight to the collector. */
      const votePixels = lw * lh;
      const scratch = {
        acc: new Float32Array(votePixels * 4),
        wsum: new Float32Array(votePixels),
        wmax: new Float32Array(votePixels),
        cost: new Float32Array(votePixels),
        agreement: new Float32Array(votePixels),
      };

      for (let pass = 0; pass < passes; pass++) {
        checkCancel();
        // Colour, gradient and structure all describe the *current* estimate, so
        // they are rebuilt each pass as the hole fills in.
        const lab = CAF.rgbaToLab(work, lw, lh);
        const analysis = CAF.structureAnalyzer.analyze(work, level.mask, lw, lh, order,
          { keepEdges: options.debug });
        if (options.debug) lastAnalysis = analysis;
        const weights = CAF.patchDistance.buildPatchWeights(holeArr, conf, level.mask, lw, lh, radius, options.patchStride);

        const scorer = CAF.patchDistance.createScorer({
          width: lw, height: lh, radius,
          lab, gx: analysis.gx, gy: analysis.gy, sd: analysis.sd,
          confidence: conf, weights,
          colorWeight: options.colorWeight,
          gradientWeight: options.gradientWeight,
          structureWeight: options.structureWeight,
          localityWeight: options.localityWeight,
          localityRef: Math.hypot(lw, lh),
          patchStride: options.patchStride,
        });

        const passBase = 0.08 + 0.82 * (step / plan.length);
        const passSpan = 0.82 / plan.length;
        CAF.patchmatch.run(ctx, {
          nnf, hole: holeArr, centers, scorer,
          iterations, searchRadius: search,
          transforms: CAF.patchDistance.transformSet(options),
          coherenceWeight: options.coherenceWeight,
          coherenceRef: options.coherenceRef,
          random,
          shouldCancel: isCancelled,
          onProgress: frac => report(`Level ${step + 1}/${plan.length}`,
            passBase + passSpan * ((pass + frac) / passes)),
        });
        checkCancel();

        const adapt = CAF.colorAdapter.buildField(ctx, {
          nnf, hole: holeArr, pixels: work, mask: level.mask,
          strength: options.colorAdaptation,
        });

        const lastPass = pass === passes - 1;
        if (finest && lastPass && options.coherentFinish) {
          CAF.patchVoting.coherentCopy(ctx, {
            nnf, hole: holeArr, source: work.slice(), out: work, mask: level.mask, adapt,
          });
        } else {
          voteInfo = CAF.patchVoting.reconstruct(ctx, {
            nnf, hole: holeArr, source: work.slice(), out: work,
            mask: level.mask, spatial, adapt,
            sharpness: sharpness * (1 + pass),
            acc: scratch.acc, wsum: scratch.wsum, wmax: scratch.wmax,
            cost: scratch.cost, agreement: scratch.agreement,
          });
          CAF.confidence.update(conf, level.mask, voteInfo.agreement, voteInfo.cost, voteInfo.sigma2);
        }
      }

      if (options.debug) {
        debug.rgba(`level-${step}-reconstruction`, work, lw, lh);
        debug.nnf(`level-${step}-nnf`, nnf, level.mask, lw, lh);
        debug.scalar(`level-${step}-confidence`, conf, lw, lh, 1);
        if (voteInfo) debug.scalar(`level-${step}-cost`, voteInfo.cost, lw, lh);
        if (lastAnalysis) {
          // §33 asks for the gradient and edge maps by name.
          const magnitude = new Float32Array(lw * lh);
          for (let i = 0; i < magnitude.length; i++) {
            magnitude[i] = Math.hypot(lastAnalysis.gx[i], lastAnalysis.gy[i]);
          }
          debug.scalar(`level-${step}-gradient`, magnitude, lw, lh);
          if (lastAnalysis.edges) debug.scalar(`level-${step}-edges`, lastAnalysis.edges, lw, lh, 1);
          debug.scalar(`level-${step}-structure-coherence`, (() => {
            const coh = new Float32Array(lw * lh);
            for (let i = 0; i < coh.length; i++) coh[i] = lastAnalysis.sd[i * 4 + 3];
            return coh;
          })(), lw, lh, 1);
        }
      }

      previous = { work, width: lw, height: lh, nnf };
      if (li === 0) { finalNnf = nnf; finalWork = work; finalLevel = level; }
    }

    if (!finalWork) {
      // Every level lacked a legal patch centre. Diffusion is the honest answer.
      const patched = new Uint8ClampedArray(roiPixels);
      CAF.inpaintFallback.inpaint(patched, maskInfo.fill, roi.width, roi.height, {
        radius: Math.max(3, options.patchRadius + 1),
        allowed: sampling.allowed,
      });
      report(STAGES.complete, 1);
      return finish({
        result, pixels, roiPixels, roiResult: patched, maskInfo, sampling,
        width, height, roi, options, debug, started,
        algorithmUsed: 'telea-fallback', nnf: null, levels: levels.length,
      });
    }

    // --- seam removal (§21) -----------------------------------------------
    report(STAGES.blend, 0.93);
    checkCancel();
    debug.rgba('raw-reconstruction', finalWork, roi.width, roi.height);
    const blendInfo = CAF.seamBlender.blend({ width: roi.width, height: roi.height }, {
      nnf: finalNnf, filled: finalWork, source: roiPixels,
      mask: finalLevel.mask, radius: options.edgeBlend,
      // Texture the surroundings already carry is not a seam.
      allowance: Math.max(8, options.textureFrequency * 2.5),
      shouldCancel: isCancelled,
    });
    debug.rgba('blended-reconstruction', finalWork, roi.width, roi.height);
    if (blendInfo.band) debug.mask('blend-band', blendInfo.band, roi.width, roi.height);

    report(STAGES.complete, 1);
    return finish({
      result, pixels, roiPixels, roiResult: finalWork, maskInfo, sampling,
      width, height, roi, options, debug, started,
      algorithmUsed: labelSeeded ? 'patchmatch+shift-labeling' : 'patchmatch',
      nnf: finalNnf, levels: levels.length,
    });
  }

  /* Scores the finished region and packages the §31 result. Runs for every path,
   * so a Telea fill is audited exactly as an exemplar one is.
   *
   * Scoring happens in ROI space — the metrics only ever look at the hole and
   * the ring around it, so there is nothing outside the region to measure and
   * running it at full frame would repeat the cost §4 exists to avoid.
   * Compositing into the full-resolution result happens here, once. */
  function finish(state) {
    const {
      result, pixels, roiPixels, roiResult, maskInfo, sampling,
      width, height, roi, options, debug, started, algorithmUsed,
    } = state;

    const rw = roi.width, rh = roi.height;
    const roiMask = maskInfo.fill;

    // --- composite the region back (§22) ---------------------------------
    for (let y = 0; y < rh; y++) {
      const roiRow = y * rw;
      const fullRow = (roi.y0 + y) * width + roi.x0;
      for (let x = 0; x < rw; x++) {
        const ri = roiRow + x;
        if (!roiMask[ri]) continue;             // outside the mask: untouched
        const src = ri * 4;
        const dst = (fullRow + x) * 4;
        result[dst] = roiResult[src];
        result[dst + 1] = roiResult[src + 1];
        result[dst + 2] = roiResult[src + 2];
        result[dst + 3] = 255;                  // §23: reconstructed area is opaque
      }
    }

    const hole = [];
    for (let i = 0; i < rw * rh; i++) if (roiMask[i]) hole.push(i);

    const nnf = state.nnf || {
      x: new Int32Array(rw * rh).fill(-1),
      y: new Int32Array(rw * rh),
      d: new Float32Array(rw * rh),
    };

    const report = CAF.qualityReport.evaluate({
      pixels: roiResult, original: roiPixels, mask: roiMask, nnf,
      width: rw, height: rh, hole,
      sourceCount: sampling.count, sourceRelaxed: sampling.relaxed,
      options,
    });

    /* The effective mask and confidence map are reported in image coordinates,
     * because that is the space the caller's mask was given in. */
    const effectiveMask = new Uint8Array(width * height);
    const confidenceMap = new Float32Array(width * height).fill(1);
    for (let y = 0; y < rh; y++) {
      const roiRow = y * rw;
      const fullRow = (roi.y0 + y) * width + roi.x0;
      for (let x = 0; x < rw; x++) {
        if (!roiMask[roiRow + x]) continue;
        effectiveMask[fullRow + x] = 1;
        confidenceMap[fullRow + x] = report.confidence;
      }
    }

    debug.rgba('final', roiResult, rw, rh);
    debug.note('algorithmUsed', algorithmUsed);
    debug.note('metrics', report.metrics);

    return {
      image: { data: result, width, height },
      pixels: result,
      width,
      height,
      processingTime: Date.now() - started,
      algorithmUsed,
      confidence: report.confidence,
      confidenceMap,
      /* Exactly which pixels were rewritten. This is the caller's mask grown by
       * options.maskExpansion (§25), so it — not the input mask — is what §22's
       * "outside is bit-identical" guarantee is stated against. With
       * maskExpansion 0 the two coincide. */
      effectiveMask,
      maskExpansion: maskInfo.expansion,
      roi: { x0: roi.x0, y0: roi.y0, width: roi.width, height: roi.height },
      lowConfidence: report.lowConfidence,
      hardRejected: report.hardRejected,
      unsafeReasons: report.unsafeReasons,
      flaggedReasons: report.flaggedReasons,
      status: report.status,
      metrics: report.metrics,
      options,
      debugInfo: debug.result(),
    };
  }

  CAF.STAGES = STAGES;
  CAF.Cancelled = Cancelled;
  CAF.computeRoi = computeRoi;
  CAF.levelPlan = levelPlan;
  CAF.fill = fill;
})(typeof self !== 'undefined' ? self : globalThis);
