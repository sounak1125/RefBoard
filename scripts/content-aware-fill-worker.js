'use strict';

/* Content-aware fill worker: nearest-valid-pixel inpainting with edge-aware blending.
 *
 * Input: { width, height, pixels: Uint8ClampedArray (transferred), mask: Uint8Array (transferred),
 *          patchRadius, maxIters }
 * Output: { pixels: Uint8ClampedArray (transferred) } — full image with hole filled.
 *
 * For each hole pixel, find the nearest valid (non-mask) pixel using a two-pass
 * distance transform, then copy that color. A small blur smooths the result.
 * This is deterministic, fast, and gives the expected "erase object" behavior.
 */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function nearestValidFill(width, height, pixels, mask) {
  const w = width, h = height;
  const total = w * h;
  const out = pixels.slice();

  // Distance transform: two-pass chamfer.
  const dist = new Float32Array(total);
  const srcX = new Int32Array(total);
  const srcY = new Int32Array(total);

  // Initialize: valid pixels have distance 0 and point to themselves.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) {
        dist[i] = Infinity;
        srcX[i] = -1;
        srcY[i] = -1;
      } else {
        dist[i] = 0;
        srcX[i] = x;
        srcY[i] = y;
      }
    }
  }

  // Forward pass: top-left to bottom-right.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let bestD = dist[i];
      let bestX = srcX[i];
      let bestY = srcY[i];
      // Check left, top-left, top, top-right.
      if (x > 0) {
        const j = i - 1;
        if (srcX[j] >= 0) {
          const d = dist[j] + 1;
          if (d < bestD) { bestD = d; bestX = srcX[j]; bestY = srcY[j]; }
        }
      }
      if (y > 0) {
        const j = i - w;
        if (srcX[j] >= 0) {
          const d = dist[j] + 1;
          if (d < bestD) { bestD = d; bestX = srcX[j]; bestY = srcY[j]; }
        }
        if (x > 0) {
          const j2 = j - 1;
          if (srcX[j2] >= 0) {
            const d2 = dist[j2] + 1.414;
            if (d2 < bestD) { bestD = d2; bestX = srcX[j2]; bestY = srcY[j2]; }
          }
        }
        if (x < w - 1) {
          const j2 = j + 1;
          if (srcX[j2] >= 0) {
            const d2 = dist[j2] + 1.414;
            if (d2 < bestD) { bestD = d2; bestX = srcX[j2]; bestY = srcY[j2]; }
          }
        }
      }
      dist[i] = bestD;
      srcX[i] = bestX;
      srcY[i] = bestY;
    }
  }

  // Backward pass: bottom-right to top-left.
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let bestD = dist[i];
      let bestX = srcX[i];
      let bestY = srcY[i];
      // Check right, bottom-right, bottom, bottom-left.
      if (x < w - 1) {
        const j = i + 1;
        if (srcX[j] >= 0) {
          const d = dist[j] + 1;
          if (d < bestD) { bestD = d; bestX = srcX[j]; bestY = srcY[j]; }
        }
      }
      if (y < h - 1) {
        const j = i + w;
        if (srcX[j] >= 0) {
          const d = dist[j] + 1;
          if (d < bestD) { bestD = d; bestX = srcX[j]; bestY = srcY[j]; }
        }
        if (x < w - 1) {
          const j2 = j + 1;
          if (srcX[j2] >= 0) {
            const d2 = dist[j2] + 1.414;
            if (d2 < bestD) { bestD = d2; bestX = srcX[j2]; bestY = srcY[j2]; }
          }
        }
        if (x > 0) {
          const j2 = j - 1;
          if (srcX[j2] >= 0) {
            const d2 = dist[j2] + 1.414;
            if (d2 < bestD) { bestD = d2; bestX = srcX[j2]; bestY = srcY[j2]; }
          }
        }
      }
      dist[i] = bestD;
      srcX[i] = bestX;
      srcY[i] = bestY;
    }
  }

  // Copy from nearest valid pixel.
  for (let i = 0; i < total; i++) {
    if (!mask[i]) continue;
    const sx = srcX[i];
    const sy = srcY[i];
    if (sx < 0) continue;
    const si = (sy * w + sx) * 4;
    const di = i * 4;
    out[di] = pixels[si];
    out[di + 1] = pixels[si + 1];
    out[di + 2] = pixels[si + 2];
    out[di + 3] = pixels[si + 3];
  }

  // Small blur to smooth seams (3x3 box blur on hole pixels only).
  const blurred = out.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let sr = 0, sg = 0, sb = 0, sa = 0, cnt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          const jp = j * 4;
          sr += out[jp];
          sg += out[jp + 1];
          sb += out[jp + 2];
          sa += out[jp + 3];
          cnt++;
        }
      }
      const p = i * 4;
      blurred[p] = sr / cnt;
      blurred[p + 1] = sg / cnt;
      blurred[p + 2] = sb / cnt;
      blurred[p + 3] = sa / cnt;
    }
  }

  return blurred;
}

self.onmessage = (e) => {
  const { width, height, pixels, mask } = e.data;
  try {
    const filled = nearestValidFill(width, height, pixels, mask);
    self.postMessage({ pixels: filled || pixels }, [filled ? filled.buffer : pixels.buffer]);
  } catch (err) {
    self.postMessage({ error: String(err?.stack || err) });
  }
};
