'use strict';
/* Diffusion inpainting for tiny holes, scratches and thin structures (§5).
 *
 * Telea's Fast Marching Method (2004), implemented directly rather than pulled
 * in through OpenCV. opencv.js is roughly nine megabytes of WebAssembly, this
 * app ships none today, and a classic worker cannot load it cleanly — for two
 * hundred lines that answer the whole requirement offline, the dependency is not
 * worth it.
 *
 * This is emphatically NOT the primary algorithm. It runs only when the mask's
 * thickest point is a few pixels, where every pixel already sits inside a patch
 * of known content and exemplar synthesis would be searching for something it
 * can see anyway. Anything larger goes to PatchMatch.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp } = CAF;

  const KNOWN = 0, BAND = 1, INSIDE = 2;
  const INF = 1e6;
  const DEFAULT_RADIUS = 4;

  /* Binary min-heap keyed on T. Flat typed arrays rather than objects: the queue
   * is touched once per pixel per march and allocation churn shows up. */
  function makeHeap(capacity) {
    const keys = new Float64Array(capacity);
    const vals = new Int32Array(capacity);
    let size = 0;
    return {
      get size() { return size; },
      push(key, val) {
        if (size >= keys.length) return;   // capacity is exact; this cannot fire
        let i = size++;
        keys[i] = key; vals[i] = val;
        while (i > 0) {
          const parent = (i - 1) >> 1;
          if (keys[parent] <= keys[i]) break;
          const tk = keys[parent], tv = vals[parent];
          keys[parent] = keys[i]; vals[parent] = vals[i];
          keys[i] = tk; vals[i] = tv;
          i = parent;
        }
      },
      pop() {
        const top = vals[0];
        size--;
        if (size > 0) {
          keys[0] = keys[size]; vals[0] = vals[size];
          let i = 0;
          for (;;) {
            const l = i * 2 + 1, r = l + 1;
            let m = i;
            if (l < size && keys[l] < keys[m]) m = l;
            if (r < size && keys[r] < keys[m]) m = r;
            if (m === i) break;
            const tk = keys[m], tv = vals[m];
            keys[m] = keys[i]; vals[m] = vals[i];
            keys[i] = tk; vals[i] = tv;
            i = m;
          }
        }
        return top;
      },
    };
  }

  /* Eikonal update from a pair of orthogonal neighbours: the arrival time of a
   * front moving at unit speed. */
  function solveEikonal(flag, T, width, height, x1, y1, x2, y2) {
    let sol = INF;
    const in1 = x1 >= 0 && y1 >= 0 && x1 < width && y1 < height;
    const in2 = x2 >= 0 && y2 >= 0 && x2 < width && y2 < height;
    const i1 = in1 ? y1 * width + x1 : -1;
    const i2 = in2 ? y2 * width + x2 : -1;
    const k1 = i1 >= 0 && flag[i1] === KNOWN;
    const k2 = i2 >= 0 && flag[i2] === KNOWN;
    if (k1) {
      if (k2) {
        const t1 = T[i1], t2 = T[i2];
        const d = 2 - (t1 - t2) * (t1 - t2);
        if (d > 0) {
          const r = Math.sqrt(d);
          let s = (t1 + t2 - r) / 2;
          if (s >= t1 && s >= t2) sol = s;
          else {
            s += r;
            if (s >= t1 && s >= t2) sol = s;
          }
        }
      } else {
        sol = 1 + T[i1];
      }
    } else if (k2) {
      sol = 1 + T[i2];
    }
    return sol;
  }

  /* Telea's estimator: known pixels inside a small disc vote, weighted by how
   * closely they lie along the front's normal (dir), how near they are (dst),
   * and how close their arrival time is (lev). The first-order term carries each
   * contributor's own gradient across the gap, which is what continues a smooth
   * ramp instead of flattening it. */
  function estimate(pixels, flag, T, width, height, p, radius, out) {
    const px = p % width, py = (p / width) | 0;

    // Front normal, from the arrival-time field.
    let nx = 0, ny = 0;
    {
      const xr = Math.min(width - 1, px + 1), xl = Math.max(0, px - 1);
      const yd = Math.min(height - 1, py + 1), yu = Math.max(0, py - 1);
      const ir = py * width + xr, il = py * width + xl;
      const id = yd * width + px, iu = yu * width + px;
      if (flag[ir] !== INSIDE && flag[il] !== INSIDE) nx = (T[ir] - T[il]) / 2;
      if (flag[id] !== INSIDE && flag[iu] !== INSIDE) ny = (T[id] - T[iu]) / 2;
    }
    const nlen = Math.hypot(nx, ny);
    if (nlen > 1e-6) { nx /= nlen; ny /= nlen; }
    else { nx = 0; ny = 0; }

    let wr = 0, wg = 0, wb = 0, wa = 0, wsum = 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const qy = py + dy;
      if (qy < 0 || qy >= height) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const qx = px + dx;
        if (qx < 0 || qx >= width) continue;
        const q = qy * width + qx;
        if (flag[q] !== KNOWN) continue;
        // r points from the contributor back to the pixel being filled.
        const rx = px - qx, ry = py - qy;
        const len2 = rx * rx + ry * ry;
        if (!len2 || len2 > radius * radius) continue;
        const len = Math.sqrt(len2);

        let dir = (nx || ny) ? Math.abs(rx * nx + ry * ny) / len : 1;
        if (dir < 1e-6) dir = 1e-6;
        const dst = 1 / len2;
        const lev = 1 / (1 + Math.abs(T[q] - T[p]));
        const w = dir * dst * lev;

        // First-order extrapolation from the contributor's own gradient.
        const qp = q * 4;
        const xr = Math.min(width - 1, qx + 1), xl = Math.max(0, qx - 1);
        const yd = Math.min(height - 1, qy + 1), yu = Math.max(0, qy - 1);
        const gr = (qy * width + xr), gl = (qy * width + xl);
        const gd = (yd * width + qx), gu = (yu * width + qx);
        const useX = flag[gr] === KNOWN && flag[gl] === KNOWN;
        const useY = flag[gd] === KNOWN && flag[gu] === KNOWN;
        for (let c = 0; c < 3; c++) {
          const gxC = useX ? (pixels[gr * 4 + c] - pixels[gl * 4 + c]) / 2 : 0;
          const gyC = useY ? (pixels[gd * 4 + c] - pixels[gu * 4 + c]) / 2 : 0;
          const v = pixels[qp + c] + gxC * rx + gyC * ry;
          if (c === 0) wr += w * v;
          else if (c === 1) wg += w * v;
          else wb += w * v;
        }
        wa += w * pixels[qp + 3];
        wsum += w;
      }
    }
    if (wsum <= 0) return false;
    out[0] = clamp(wr / wsum, 0, 255);
    out[1] = clamp(wg / wsum, 0, 255);
    out[2] = clamp(wb / wsum, 0, 255);
    out[3] = clamp(wa / wsum, 0, 255);
    return true;
  }

  /* `allowed` is optional; when present, only pixels the sampling area permits
   * may be read as known content, so §17 holds here too. */
  function inpaint(pixels, mask, width, height, options) {
    const opts = options || {};
    const radius = clamp(opts.radius || DEFAULT_RADIUS, 1, 16);
    const allowed = opts.allowed || null;
    const total = width * height;

    const flag = new Uint8Array(total);
    const T = new Float64Array(total);
    for (let i = 0; i < total; i++) {
      if (mask[i]) { flag[i] = INSIDE; T[i] = INF; }
      else if (allowed && !allowed[i]) { flag[i] = INSIDE; T[i] = INF; }
      else { flag[i] = KNOWN; T[i] = 0; }
    }

    const heap = makeHeap(total + 1);
    // Seed the band with masked pixels touching known content.
    for (let p = 0; p < total; p++) {
      if (flag[p] !== INSIDE) continue;
      const px = p % width, py = (p / width) | 0;
      let touches = false;
      if (px > 0 && flag[p - 1] === KNOWN) touches = true;
      else if (px + 1 < width && flag[p + 1] === KNOWN) touches = true;
      else if (py > 0 && flag[p - width] === KNOWN) touches = true;
      else if (py + 1 < height && flag[p + width] === KNOWN) touches = true;
      if (!touches) continue;
      flag[p] = BAND;
      T[p] = 0;
      heap.push(0, p);
    }

    const out = pixels;
    const sample = new Float64Array(4);
    let filled = 0;

    while (heap.size > 0) {
      const p = heap.pop();
      if (flag[p] === KNOWN) continue;
      flag[p] = KNOWN;
      const px = p % width, py = (p / width) | 0;
      for (let t = 0; t < 4; t++) {
        const qx = px + (t === 0 ? -1 : t === 1 ? 1 : 0);
        const qy = py + (t === 2 ? -1 : t === 3 ? 1 : 0);
        if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
        const q = qy * width + qx;
        if (flag[q] !== INSIDE) continue;

        T[q] = Math.min(
          Math.min(
            solveEikonal(flag, T, width, height, qx - 1, qy, qx, qy - 1),
            solveEikonal(flag, T, width, height, qx + 1, qy, qx, qy - 1)),
          Math.min(
            solveEikonal(flag, T, width, height, qx - 1, qy, qx, qy + 1),
            solveEikonal(flag, T, width, height, qx + 1, qy, qx, qy + 1)));

        if (estimate(out, flag, T, width, height, q, radius, sample)) {
          const o = q * 4;
          out[o] = sample[0];
          out[o + 1] = sample[1];
          out[o + 2] = sample[2];
          // Alpha becomes opaque wherever real content was reconstructed (§23).
          out[o + 3] = mask[q] ? 255 : sample[3];
          filled++;
        }
        flag[q] = BAND;
        heap.push(T[q], q);
      }
    }

    return { pixels: out, filled };
  }

  CAF.inpaintFallback = {
    KNOWN, BAND, INSIDE,
    DEFAULT_RADIUS,
    makeHeap,
    solveEikonal,
    estimate,
    inpaint,
  };
})(typeof self !== 'undefined' ? self : globalThis);
