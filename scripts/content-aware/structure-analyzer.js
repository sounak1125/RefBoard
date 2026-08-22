'use strict';
/* Structure preservation (§16).
 *
 * Texture matching has no opinion about where an edge goes. A horizon crossing
 * the hole gets filled with whatever matches locally on each side, and the line
 * breaks in the middle — a broken line reads as a patch even when the texture
 * around it is right.
 *
 * The exemplar literature handles this as a fill *order*: rank the fill front by
 * how strongly an isophote runs into it and complete those patches first. That
 * assumes a greedy onion-peel, and this solver fills everything at once, so the
 * equivalent is to predict where structure ought to continue and make matching
 * answer to the prediction.
 *
 * The prediction is a structure tensor, smoothed over known pixels only, then
 * carried into the hole along its own orientation: a neighbour gets a say in
 * proportion to how little the image varies in its direction, which is exactly
 * the direction an edge runs. A horizontal edge therefore propagates sideways
 * across the gap instead of being averaged away by the flat regions above and
 * below it.
 *
 * Ported from the previous engine, with its central differences replaced by
 * Sobel: the 3x3 kernel is smoothed along the edge, so a one-pixel noise spike
 * no longer registers as structure.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp } = CAF;

  const STRUCT_BLUR_RADIUS = 3;
  const STRUCT_BASE_W = 0.15;
  const STRUCT_TRANSPORT_POWER = 6;
  const STRUCT_SWEEPS = 2;
  const STRUCT_MIN_COH = 0.6;

  /* Sobel over a luma plane. Edge pixels replicate, which keeps the gradient
   * finite everywhere.
   *
   * The interior and the border are separate loops on purpose. A single loop
   * needs a clamped accessor, and at eight samples per pixel that is eight
   * closure calls with two clamps each for every pixel of the region — on a
   * megapixel region-of-interest, eight million of them, rebuilt at every
   * pyramid level. The interior loop below indexes directly. */
  function sobel(lumaPlane, width, height) {
    const total = width * height;
    const gx = new Float32Array(total);
    const gy = new Float32Array(total);

    for (let y = 1; y < height - 1; y++) {
      const up = (y - 1) * width, mid = y * width, dn = (y + 1) * width;
      for (let x = 1; x < width - 1; x++) {
        const tl = lumaPlane[up + x - 1], tc = lumaPlane[up + x], tr = lumaPlane[up + x + 1];
        const ml = lumaPlane[mid + x - 1], mr = lumaPlane[mid + x + 1];
        const bl = lumaPlane[dn + x - 1], bc = lumaPlane[dn + x], br = lumaPlane[dn + x + 1];
        const i = mid + x;
        // Divided by 8 so magnitudes stay on the same scale as a plain difference.
        gx[i] = ((tr + 2 * mr + br) - (tl + 2 * ml + bl)) / 8;
        gy[i] = ((bl + 2 * bc + br) - (tl + 2 * tc + tr)) / 8;
      }
    }

    // Border ring, with replication. A handful of pixels, so clarity wins here.
    const at = (x, y) => lumaPlane[clamp(y, 0, height - 1) * width + clamp(x, 0, width - 1)];
    const edge = (x, y) => {
      const tl = at(x - 1, y - 1), tc = at(x, y - 1), tr = at(x + 1, y - 1);
      const ml = at(x - 1, y), mr = at(x + 1, y);
      const bl = at(x - 1, y + 1), bc = at(x, y + 1), br = at(x + 1, y + 1);
      const i = y * width + x;
      gx[i] = ((tr + 2 * mr + br) - (tl + 2 * ml + bl)) / 8;
      gy[i] = ((bl + 2 * bc + br) - (tl + 2 * tc + tr)) / 8;
    };
    for (let x = 0; x < width; x++) { edge(x, 0); if (height > 1) edge(x, height - 1); }
    for (let y = 1; y < height - 1; y++) { edge(0, y); if (width > 1) edge(width - 1, y); }

    return { gx, gy };
  }

  /* Gradient magnitude, normalised to 0..1 by a high percentile so a single
   * specular highlight does not flatten the rest of the map. */
  function edgeMap(gx, gy) {
    const total = gx.length;
    const mag = new Float32Array(total);
    for (let i = 0; i < total; i++) mag[i] = Math.hypot(gx[i], gy[i]);
    const sample = [];
    const step = Math.max(1, (total / 20000) | 0);
    for (let i = 0; i < total; i += step) sample.push(mag[i]);
    const scale = CAF.percentile(sample, 0.98, 1) || 1;
    for (let i = 0; i < total; i++) mag[i] = clamp(mag[i] / scale, 0, 1);
    return mag;
  }

  /* J = grad(I) grad(I)^T, box-blurred over known pixels only so the object
   * being erased contributes nothing to what we extrapolate from. */
  function buildTensor(gx, gy, mask, width, height, radius) {
    const total = width * height;
    const jxx = new Float32Array(total);
    const jxy = new Float32Array(total);
    const jyy = new Float32Array(total);
    const known = new Uint8Array(total);
    for (let i = 0; i < total; i++) {
      if (mask[i]) continue;
      known[i] = 1;
      const a = gx[i], b = gy[i];
      jxx[i] = a * a; jxy[i] = a * b; jyy[i] = b * b;
    }
    const r = radius === undefined ? STRUCT_BLUR_RADIUS : radius;
    CAF.maskedBoxBlur(jxx, known, width, height, r, jxx);
    CAF.maskedBoxBlur(jxy, known, width, height, r, jxy);
    CAF.maskedBoxBlur(jyy, known, width, height, r, jyy);
    return { jxx, jxy, jyy };
  }

  const NB = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  /* `order` lists hole pixels outward-in, so every pixel is reached after the
   * neighbours nearer the boundary it draws from and one pass already carries
   * structure the whole way across. */
  function propagate(tensor, mask, width, height, order, sweeps) {
    const { jxx, jxy, jyy } = tensor;
    const total = width * height;
    const known = new Uint8Array(total);
    for (let i = 0; i < total; i++) known[i] = mask[i] ? 0 : 1;

    const weightOf = (q, dx, dy) => {
      const a = jxx[q], b = jxy[q], c = jyy[q];
      const tr = a + c;
      if (tr <= 1e-6) return STRUCT_BASE_W;
      // Energy of the image variation along this step direction, normalised.
      // Small means the step runs along the edge — the direction structure
      // should travel.
      const e = (a * dx * dx + 2 * b * dx * dy + c * dy * dy) / tr;
      const along = 1 - clamp(e, 0, 1);
      const coh = Math.sqrt((a - c) * (a - c) + 4 * b * b) / tr;
      let k = along;
      for (let t = 1; t < STRUCT_TRANSPORT_POWER; t++) k *= along;
      return STRUCT_BASE_W + coh * k;
    };

    const relax = (p, requireKnown) => {
      const x = p % width;
      const y = (p / width) | 0;
      let sxx = 0, sxy = 0, syy = 0, sw = 0;
      for (let t = 0; t < 4; t++) {
        const qx = x + NB[t][0];
        const qy = y + NB[t][1];
        if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
        const q = qy * width + qx;
        if (requireKnown && !known[q]) continue;
        const wq = weightOf(q, -NB[t][0], -NB[t][1]);
        sxx += wq * jxx[q]; sxy += wq * jxy[q]; syy += wq * jyy[q]; sw += wq;
      }
      if (sw > 0) {
        const inv = 1 / sw;
        jxx[p] = sxx * inv; jxy[p] = sxy * inv; jyy[p] = syy * inv;
      }
    };

    for (let k = 0; k < order.length; k++) {
      const p = order[k];
      relax(p, true);
      known[p] = 1;
    }
    const passes = sweeps === undefined ? STRUCT_SWEEPS : sweeps;
    for (let s = 0; s < passes; s++) {
      for (let k = 0; k < order.length; k++) relax(order[k], false);
    }
    return tensor;
  }

  /* Normalised tensor plus a coherence strength, so scoring can ask "does this
   * source carry the structure this position is supposed to have" without
   * contrast entering into it.
   *
   * Interleaved into one array rather than three. The scorer reads this at the
   * source position, which jumps all over the image, so parallel arrays cost a
   * cache miss each per candidate; packed together it is one line. */
  function normalize(tensor, width, height) {
    const { jxx, jxy, jyy } = tensor;
    const total = width * height;
    const sd = new Float32Array(total * 4);
    for (let i = 0; i < total; i++) {
      const a = jxx[i], b = jxy[i], c = jyy[i];
      const tr = a + c;
      if (tr <= 1e-6) continue;
      const inv = 1 / tr;
      const o = i * 4;
      sd[o] = a * inv;
      sd[o + 1] = b * inv;
      sd[o + 2] = c * inv;
      sd[o + 3] = Math.sqrt((a - c) * (a - c) + 4 * b * b) * inv;
    }
    return sd;
  }

  /* Frobenius distance between two normalised tensors, gated on the target
   * actually having structure worth preserving. Returns 0 where it does not, so
   * flat regions pay nothing. */
  function term(sd, targetIndex, sourceIndex) {
    const t = targetIndex * 4;
    const coh = sd[t + 3];
    if (coh < STRUCT_MIN_COH) return 0;
    const s = sourceIndex * 4;
    const d0 = sd[t] - sd[s];
    const d1 = sd[t + 1] - sd[s + 1];
    const d2 = sd[t + 2] - sd[s + 2];
    return coh * (d0 * d0 + 2 * d1 * d1 + d2 * d2);
  }

  /* Full analysis for one pyramid level. `order` must be hole pixels sorted
   * outward-in (see confidence.fillOrder).
   *
   * The edge map and the raw tensor are only produced when a caller asks. On a
   * large region-of-interest each is tens to hundreds of megabytes, scoring
   * reads neither of them — it reads the Sobel gradients and the normalised
   * descriptor — and the whole set is rebuilt every reconstruction pass. */
  function analyze(pixels, mask, width, height, order, options) {
    const opts = options || {};
    const lumaPlane = CAF.lumaPlane(pixels, width, height);
    const { gx, gy } = sobel(lumaPlane, width, height);
    const tensor = buildTensor(gx, gy, mask, width, height);
    propagate(tensor, mask, width, height, order);
    const sd = normalize(tensor, width, height);
    const out = { luma: lumaPlane, gx, gy, sd };
    if (opts.keepEdges) out.edges = edgeMap(gx, gy);
    if (opts.keepTensor) out.tensor = tensor;
    return out;
  }

  CAF.structureAnalyzer = {
    STRUCT_MIN_COH,
    STRUCT_BLUR_RADIUS,
    sobel,
    edgeMap,
    buildTensor,
    propagate,
    normalize,
    term,
    analyze,
  };
})(typeof self !== 'undefined' ? self : globalThis);
