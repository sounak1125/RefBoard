'use strict';
/* Shared primitives for the content-aware fill engine.
 *
 * Every module in this directory is a plain script that registers itself on a
 * single `CAF` namespace. That keeps two consumers working with no build step:
 * the worker loads them with importScripts(), and the Node tests run the same
 * sources through vm.runInContext(). Nothing here may use `import`/`require`.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  /* mulberry32. Small, fast, and seedable, which is what §8's reproducibility
   * requirement needs: same image + mask + settings + seed => same result. */
  function makeRandom(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function random() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------------------------------------------------
   * Colour.
   *
   * Patch distance is measured in CIELAB, so a given numeric difference means
   * roughly the same perceptual difference everywhere in the gamut. Raw sRGB
   * SSD — what the previous engine used — under-weights differences in dark
   * regions and over-weights them in saturated ones, which is one reason its
   * matches were noisy.
   *
   * Stored as Int16 at 1/64 unit precision rather than Float32: L spans 0..100
   * and a/b span roughly ±128, so the scaled range fits Int16 comfortably while
   * halving what is by far the largest buffer the engine allocates.
   * ------------------------------------------------------------------- */
  const LAB_SCALE = 64;

  const SRGB_TO_LINEAR = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  // D65 white point, the reference for sRGB.
  const XN = 0.95047, YN = 1.0, ZN = 1.08883;
  const labF = t => (t > 0.008856451679035631 ? Math.cbrt(t) : t * 7.787037037037035 + 0.13793103448275862);

  /* Packs an RGBA buffer into interleaved scaled Lab. Alpha is ignored here;
   * validity is the mask's job, not the colour space's. */
  function rgbaToLab(pixels, width, height) {
    const total = width * height;
    const lab = new Int16Array(total * 3);
    for (let i = 0; i < total; i++) {
      const p = i * 4;
      const r = SRGB_TO_LINEAR[pixels[p]];
      const g = SRGB_TO_LINEAR[pixels[p + 1]];
      const b = SRGB_TO_LINEAR[pixels[p + 2]];
      const fx = labF((r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / XN);
      const fy = labF((r * 0.2126729 + g * 0.7151522 + b * 0.0721750) / YN);
      const fz = labF((r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / ZN);
      const o = i * 3;
      lab[o] = (116 * fy - 16) * LAB_SCALE;
      lab[o + 1] = 500 * (fx - fy) * LAB_SCALE;
      lab[o + 2] = 200 * (fy - fz) * LAB_SCALE;
    }
    return lab;
  }

  // Rec.601 luma straight off an RGBA buffer, for gradients and texture stats.
  const luma = (pixels, p) => pixels[p] * 0.299 + pixels[p + 1] * 0.587 + pixels[p + 2] * 0.114;

  function lumaPlane(pixels, width, height) {
    const total = width * height;
    const out = new Float32Array(total);
    for (let i = 0; i < total; i++) out[i] = luma(pixels, i * 4);
    return out;
  }

  /* ---------------------------------------------------------------------
   * Distance transforms.
   *
   * Two-pass chamfer, which is a close enough approximation of Euclidean for
   * everything here (fill ordering, band selection, feather ramps) and costs a
   * fraction of an exact transform.
   * ------------------------------------------------------------------- */
  const D_ORTH = 1, D_DIAG = Math.SQRT2;

  /* Distance from every pixel to the nearest pixel where `isSeed` is truthy.
   * Seeds get 0; everything else gets its chamfer distance, capped at `cap`. */
  function distanceField(seed, width, height, cap) {
    const total = width * height;
    const limit = cap === undefined ? Infinity : cap;
    const inf = limit === Infinity ? total * 2 : limit + 2;
    const dist = new Float32Array(total);
    for (let i = 0; i < total; i++) dist[i] = seed[i] ? 0 : inf;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let d = dist[i];
        if (d === 0) continue;
        if (x) d = Math.min(d, dist[i - 1] + D_ORTH);
        if (y) d = Math.min(d, dist[i - width] + D_ORTH);
        if (x && y) d = Math.min(d, dist[i - width - 1] + D_DIAG);
        if (x + 1 < width && y) d = Math.min(d, dist[i - width + 1] + D_DIAG);
        dist[i] = d;
      }
    }
    for (let y = height - 1; y >= 0; y--) {
      for (let x = width - 1; x >= 0; x--) {
        const i = y * width + x;
        let d = dist[i];
        if (d === 0) continue;
        if (x + 1 < width) d = Math.min(d, dist[i + 1] + D_ORTH);
        if (y + 1 < height) d = Math.min(d, dist[i + width] + D_ORTH);
        if (x + 1 < width && y + 1 < height) d = Math.min(d, dist[i + width + 1] + D_DIAG);
        if (x && y + 1 < height) d = Math.min(d, dist[i + width - 1] + D_DIAG);
        dist[i] = d;
      }
    }
    return dist;
  }

  /* How deep inside the hole each masked pixel sits: distance to the nearest
   * known pixel. Zero outside the hole. This is the ordering §15 asks for. */
  function insideDepth(mask, width, height) {
    const total = width * height;
    const known = new Uint8Array(total);
    for (let i = 0; i < total; i++) known[i] = mask[i] ? 0 : 1;
    const dist = distanceField(known, width, height);
    for (let i = 0; i < total; i++) if (!mask[i]) dist[i] = 0;
    return dist;
  }

  /* Grows a binary mask by `radius`, measured with the same chamfer metric. */
  function dilateMask(mask, width, height, radius) {
    if (!(radius > 0)) return Uint8Array.from(mask);
    const dist = distanceField(mask, width, height, radius);
    const total = width * height;
    const out = new Uint8Array(total);
    for (let i = 0; i < total; i++) out[i] = dist[i] <= radius ? 1 : 0;
    return out;
  }

  function erodeMask(mask, width, height, radius) {
    if (!(radius > 0)) return Uint8Array.from(mask);
    const total = width * height;
    const inverse = new Uint8Array(total);
    for (let i = 0; i < total; i++) inverse[i] = mask[i] ? 0 : 1;
    const dist = distanceField(inverse, width, height, radius);
    const out = new Uint8Array(total);
    for (let i = 0; i < total; i++) out[i] = mask[i] && dist[i] > radius ? 1 : 0;
    return out;
  }

  /* ---------------------------------------------------------------------
   * Separable box blur over a scalar plane, skipping pixels the caller marks
   * invalid. Used by the structure analyser so masked pixels never leak into
   * the tensor field around the hole.
   * ------------------------------------------------------------------- */
  function maskedBoxBlur(src, valid, width, height, radius, out) {
    const total = width * height;
    const dst = out || new Float32Array(total);
    const tmpV = new Float32Array(total);
    const tmpW = new Float32Array(total);
    for (let y = 0; y < height; y++) {
      const row = y * width;
      let sum = 0, weight = 0;
      for (let x = -radius; x <= radius; x++) {
        const cx = clamp(x, 0, width - 1);
        if (valid[row + cx]) { sum += src[row + cx]; weight++; }
      }
      for (let x = 0; x < width; x++) {
        tmpV[row + x] = sum;
        tmpW[row + x] = weight;
        const drop = clamp(x - radius, 0, width - 1);
        const add = clamp(x + radius + 1, 0, width - 1);
        if (x - radius >= 0 && valid[row + drop]) { sum -= src[row + drop]; weight--; }
        if (x + radius + 1 < width && valid[row + add]) { sum += src[row + add]; weight++; }
      }
    }
    for (let x = 0; x < width; x++) {
      let sum = 0, weight = 0;
      for (let y = -radius; y <= radius; y++) {
        const cy = clamp(y, 0, height - 1);
        sum += tmpV[cy * width + x]; weight += tmpW[cy * width + x];
      }
      for (let y = 0; y < height; y++) {
        const i = y * width + x;
        dst[i] = weight > 0 ? sum / weight : 0;
        const dropY = clamp(y - radius, 0, height - 1);
        const addY = clamp(y + radius + 1, 0, height - 1);
        if (y - radius >= 0) { sum -= tmpV[dropY * width + x]; weight -= tmpW[dropY * width + x]; }
        if (y + radius + 1 < height) { sum += tmpV[addY * width + x]; weight += tmpW[addY * width + x]; }
      }
    }
    return dst;
  }

  /* Bounding box of the truthy pixels of a mask, or null when it is empty. */
  function maskBounds(mask, width, height) {
    let x0 = width, y0 = height, x1 = -1, y1 = -1;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        if (!mask[row + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    return x1 < x0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1, width: x1 + 1 - x0, height: y1 + 1 - y0 };
  }

  function countMask(mask) {
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
    return n;
  }

  /* Percentile of an array of finite numbers. Copies before sorting so callers
   * keep their ordering. Returns `fallback` for an empty input. */
  function percentile(values, q, fallback) {
    const finite = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (Number.isFinite(v)) finite.push(v);
    }
    if (!finite.length) return fallback === undefined ? 0 : fallback;
    finite.sort((a, b) => a - b);
    const idx = clamp(Math.round((finite.length - 1) * q), 0, finite.length - 1);
    return finite[idx];
  }

  function median(values, fallback) { return percentile(values, 0.5, fallback); }

  /* Median plus median-absolute-deviation, rescaled so it is comparable with a
   * standard deviation on normal data. Robust against the outliers a boundary
   * ring picks up from the object being removed. */
  function medianMad(values, fallback) {
    const m = median(values, fallback === undefined ? 0 : fallback);
    if (!values.length) return { median: m, mad: 0 };
    const deviations = new Array(values.length);
    for (let i = 0; i < values.length; i++) deviations[i] = Math.abs(values[i] - m);
    return { median: m, mad: median(deviations, 0) * 1.4826 };
  }

  CAF.clamp = clamp;
  CAF.makeRandom = makeRandom;
  CAF.LAB_SCALE = LAB_SCALE;
  CAF.rgbaToLab = rgbaToLab;
  CAF.luma = luma;
  CAF.lumaPlane = lumaPlane;
  CAF.distanceField = distanceField;
  CAF.insideDepth = insideDepth;
  CAF.dilateMask = dilateMask;
  CAF.erodeMask = erodeMask;
  CAF.maskedBoxBlur = maskedBoxBlur;
  CAF.maskBounds = maskBounds;
  CAF.countMask = countMask;
  CAF.percentile = percentile;
  CAF.median = median;
  CAF.medianMad = medianMad;
})(typeof self !== 'undefined' ? self : globalThis);
