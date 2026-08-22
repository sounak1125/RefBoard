'use strict';
/* Source-region control (§17) and source-mask safety (§18).
 *
 * Produces the single authority on where a patch may be sampled from, and the
 * derived map of which pixels are legal *patch centres* — a centre is only legal
 * when the whole patch around it sits inside the allowed region, which is what
 * stops half a patch of the erased object being dragged back into the hole.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp, dilateMask, countMask } = CAF;

  const OPAQUE_ENOUGH = 8;   // alpha below this is treated as absent canvas

  /* `userMask` is optional and follows §3's convention: 255 = may sample,
   * 0 = forbidden. Absent means "everywhere that is otherwise legal". */
  function build(fillMask, pixels, width, height, options, userMask) {
    const total = width * height;
    const opts = options || {};
    const dilation = clamp(opts.forbiddenDilation | 0, 0, 64);

    /* §18: the forbidden zone is the fill mask grown further still. Pixels a
     * few px outside the object carry its halo, its shadow, and its colour
     * fringing; sampling them reproduces the object you just removed. */
    const forbidden = dilation > 0 ? dilateMask(fillMask, width, height, dilation) : fillMask;

    const allowed = new Uint8Array(total);
    let transparentRejected = 0;
    let userRejected = 0;
    for (let i = 0; i < total; i++) {
      if (forbidden[i]) continue;
      if (pixels[i * 4 + 3] < OPAQUE_ENOUGH) { transparentRejected++; continue; }
      if (userMask && userMask[i] < 128) { userRejected++; continue; }
      allowed[i] = 1;
    }

    let relaxed = false;
    let count = countMask(allowed);

    /* An over-painted sampling area is a user error worth recovering from
     * rather than failing on: drop the user's restriction, keep every safety
     * rule, and let the quality report say the area was too small. */
    if (userMask && count < 64) {
      for (let i = 0; i < total; i++) {
        if (forbidden[i]) continue;
        if (pixels[i * 4 + 3] < OPAQUE_ENOUGH) continue;
        allowed[i] = 1;
      }
      relaxed = true;
      count = countMask(allowed);
    }

    return { allowed, forbidden, count, relaxed, transparentRejected, userRejected };
  }

  /* Summed-area table over `allowed`, so "is every pixel of this patch legal?"
   * is four lookups regardless of patch size. Counts top out at width*height,
   * which stays well inside Int32 even for a 6000x4000 source. */
  function buildValidCenters(allowed, width, height, radius) {
    const stride = width + 1;
    const sat = new Int32Array(stride * (height + 1));
    for (let y = 0; y < height; y++) {
      let rowSum = 0;
      const src = y * width;
      const cur = (y + 1) * stride;
      const prev = y * stride;
      for (let x = 0; x < width; x++) {
        rowSum += allowed[src + x] ? 1 : 0;
        sat[cur + x + 1] = sat[prev + x + 1] + rowSum;
      }
    }
    const rect = (x0, y0, x1, y1) =>
      sat[y1 * stride + x1] - sat[y0 * stride + x1] - sat[y1 * stride + x0] + sat[y0 * stride + x0];

    const total = width * height;
    const valid = new Uint8Array(total);
    const side = radius * 2 + 1;
    const full = side * side;

    /* Counted first, then filled. On a megapixel region almost every pixel is a
     * legal centre, and growing two ordinary arrays by a million pushes — then
     * copying both into typed arrays — costs more than running the (already
     * O(1) per pixel) test twice. */
    let count = 0;
    for (let y = radius; y < height - radius; y++) {
      for (let x = radius; x < width - radius; x++) {
        if (rect(x - radius, y - radius, x + radius + 1, y + radius + 1) !== full) continue;
        valid[y * width + x] = 1;
        count++;
      }
    }
    const xs = new Int32Array(count);
    const ys = new Int32Array(count);
    let k = 0;
    for (let y = radius; y < height - radius; y++) {
      const row = y * width;
      for (let x = radius; x < width - radius; x++) {
        if (!valid[row + x]) continue;
        xs[k] = x;
        ys[k] = y;
        k++;
      }
    }
    return { valid, xs, ys, count };
  }

  /* How much legal source there is relative to what has to be rebuilt. Below
   * about 3x the engine is copying the same few patches over and over, which is
   * the repetitive-artefact regime §34 wants flagged. */
  function coverageRatio(sourceCount, holeArea) {
    if (!holeArea) return Infinity;
    return sourceCount / holeArea;
  }

  CAF.samplingArea = {
    OPAQUE_ENOUGH,
    build,
    buildValidCenters,
    coverageRatio,
  };
})(typeof self !== 'undefined' ? self : globalThis);
