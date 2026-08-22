'use strict';
/* The nearest-neighbour field (§7).
 *
 * One entry per pixel rather than one per hole pixel, so propagation can read a
 * neighbour's match with a single index arithmetic step instead of a lookup
 * table. Only hole entries carry meaning; `x` stays -1 everywhere else.
 *
 * Every proposed source must be a legal patch centre (see samplingArea), which
 * enforces §7's list in one test: inside the image, clear of the fill region,
 * clear of forbidden sampling, and with a full patch of valid pixels around it.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp } = CAF;

  const SNAP_RADIUS = 12;

  function create(width, height) {
    const total = width * height;
    const x = new Int32Array(total).fill(-1);
    const y = new Int32Array(total).fill(-1);
    const d = new Float32Array(total).fill(Infinity);
    const t = new Uint8Array(total);
    return { x, y, d, t, width, height };
  }

  /* §8: every target starts on a random legal source. Deterministic given the
   * seed, so the same inputs reproduce the same output exactly. */
  function randomInit(nnf, hole, centers, random) {
    const n = centers.count;
    if (!n) return nnf;
    for (let k = 0; k < hole.length; k++) {
      const p = hole[k];
      const pick = (random() * n) | 0;
      nnf.x[p] = centers.xs[pick];
      nnf.y[p] = centers.ys[pick];
      nnf.d[p] = Infinity;
      nnf.t[p] = 0;
    }
    return nnf;
  }

  /* Seeds the field from a shift-labelling solution: each hole pixel adopts the
   * translation its label chose. This is the whole point of running labelling
   * first — instead of starting from noise, PatchMatch starts from a layout that
   * is already made of large contiguous pieces of the real photograph, and
   * spends its iterations refining rather than discovering.
   *
   * A pixel whose labelled source is not a legal patch centre falls back to a
   * random one, so the guarantee that every entry is legal still holds. */
  function seedFromShifts(nnf, hole, labels, shifts, centers, width, height, random) {
    if (!shifts || !shifts.length) return randomInit(nnf, hole, centers, random);
    const n = centers.count;
    let seeded = 0;
    for (let k = 0; k < hole.length; k++) {
      const p = hole[k];
      const label = labels[k];
      const shift = shifts[label] || shifts[0];
      const sx = (p % width) + shift.dx;
      const sy = ((p / width) | 0) + shift.dy;
      if (sx >= 0 && sy >= 0 && sx < width && sy < height && centers.valid[sy * width + sx]) {
        nnf.x[p] = sx;
        nnf.y[p] = sy;
        nnf.d[p] = Infinity;
        nnf.t[p] = 0;
        seeded++;
      } else if (n) {
        const pick = (random() * n) | 0;
        nnf.x[p] = centers.xs[pick];
        nnf.y[p] = centers.ys[pick];
        nnf.d[p] = Infinity;
        nnf.t[p] = 0;
      }
    }
    return { nnf, seeded };
  }

  /* Nearest legal centre to (x, y), searched as a growing square. Returns -1
   * when nothing legal is within SNAP_RADIUS. */
  function snapToValid(centers, width, height, x, y) {
    if (x >= 0 && y >= 0 && x < width && y < height && centers.valid[y * width + x]) return y * width + x;
    for (let r = 1; r <= SNAP_RADIUS; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const sy = y + dy;
        if (sy < 0 || sy >= height) continue;
        const edge = Math.abs(dy) === r;
        for (let dx = -r; dx <= r; dx += edge ? 1 : 2 * r) {
          const sx = x + dx;
          if (sx < 0 || sx >= width) continue;
          if (centers.valid[sy * width + sx]) return sy * width + sx;
        }
      }
    }
    return -1;
  }

  /* Carries a solved field up to the next finer level.
   *
   * It is the *offset* that scales, never the absolute source position. Scaling
   * the position instead collapses adjacent fine pixels onto a single source
   * pixel — two targets that both round into the same coarse cell receive the
   * same source — which magnifies the source by the pyramid factor and halves
   * the grain at every level. Measured on stochastic texture that cost about
   * 35% of the surroundings' high-frequency energy per pyramid, which reads as
   * exactly the softness this engine exists to avoid.
   *
   * Anything landing somewhere illegal snaps to the nearest legal centre, and
   * only falls back to random when even that fails. */
  function upsample(coarse, coarseW, coarseH, fine, fineW, fineH, hole, centers, random) {
    const scaleX = fineW / coarseW;
    const scaleY = fineH / coarseH;
    const n = centers.count;
    for (let k = 0; k < hole.length; k++) {
      const p = hole[k];
      const px = p % fineW;
      const py = (p / fineW) | 0;
      const cx = Math.min(coarseW - 1, (px / scaleX) | 0);
      const cy = Math.min(coarseH - 1, (py / scaleY) | 0);
      const c = cy * coarseW + cx;
      let sx = -1, sy = -1;
      if (coarse.x[c] >= 0) {
        sx = px + Math.round((coarse.x[c] - cx) * scaleX);
        sy = py + Math.round((coarse.y[c] - cy) * scaleY);
      }
      const snapped = sx >= 0 ? snapToValid(centers, fineW, fineH, sx, sy) : -1;
      if (snapped >= 0) {
        fine.x[p] = snapped % fineW;
        fine.y[p] = (snapped / fineW) | 0;
        fine.t[p] = coarse.t[c];
      } else if (n) {
        const pick = (random() * n) | 0;
        fine.x[p] = centers.xs[pick];
        fine.y[p] = centers.ys[pick];
        fine.t[p] = 0;
      }
      fine.d[p] = Infinity;
    }
    return fine;
  }

  /* How coherent the field is: the share of hole pixels whose offset matches at
   * least one 4-neighbour's. A field made of large contiguous regions scores
   * near 1; the fragmented field that produces a smudge scores near 0. */
  function coherenceRatio(nnf, hole, width, height) {
    let agree = 0;
    for (let k = 0; k < hole.length; k++) {
      const p = hole[k];
      if (nnf.x[p] < 0) continue;
      const px = p % width;
      const py = (p / width) | 0;
      const ox = nnf.x[p] - px;
      const oy = nnf.y[p] - py;
      let matched = false;
      if (px > 0 && nnf.x[p - 1] >= 0 && nnf.x[p - 1] - (px - 1) === ox && nnf.y[p - 1] - py === oy) matched = true;
      if (!matched && px + 1 < width && nnf.x[p + 1] >= 0 && nnf.x[p + 1] - (px + 1) === ox && nnf.y[p + 1] - py === oy) matched = true;
      if (!matched && py > 0 && nnf.x[p - width] >= 0 && nnf.x[p - width] - px === ox && nnf.y[p - width] - (py - 1) === oy) matched = true;
      if (!matched && py + 1 < height && nnf.x[p + width] >= 0 && nnf.x[p + width] - px === ox && nnf.y[p + width] - (py + 1) === oy) matched = true;
      if (matched) agree++;
    }
    return hole.length ? agree / hole.length : 0;
  }

  CAF.nnf = {
    SNAP_RADIUS,
    create,
    randomInit,
    seedFromShifts,
    snapToValid,
    upsample,
    coherenceRatio,
  };
})(typeof self !== 'undefined' ? self : globalThis);
