/* Outward feather compositing helpers kept for engine unit tests. Not used by the product UI. */

function outwardFeatherAlpha(mask, w, h, radius) {
  const count = w * h;
  const alpha = new Uint8ClampedArray(count);
  if (radius <= 0) {
    for (let i = 0; i < count; i++) alpha[i] = mask[i] ? 255 : 0;
    return alpha;
  }
  const inf = radius + 2;
  const dist = new Float32Array(count);
  for (let i = 0; i < count; i++) dist[i] = mask[i] ? 0 : inf;
  const diagonal = Math.SQRT2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    let d = dist[i];
    if (x) d = Math.min(d, dist[i - 1] + 1);
    if (y) d = Math.min(d, dist[i - w] + 1);
    if (x && y) d = Math.min(d, dist[i - w - 1] + diagonal);
    if (x + 1 < w && y) d = Math.min(d, dist[i - w + 1] + diagonal);
    dist[i] = d;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    let d = dist[i];
    if (x + 1 < w) d = Math.min(d, dist[i + 1] + 1);
    if (y + 1 < h) d = Math.min(d, dist[i + w] + 1);
    if (x + 1 < w && y + 1 < h) d = Math.min(d, dist[i + w + 1] + diagonal);
    if (x && y + 1 < h) d = Math.min(d, dist[i + w - 1] + diagonal);
    dist[i] = d;
  }
  for (let i = 0; i < count; i++) {
    if (mask[i]) alpha[i] = 255;
    else if (dist[i] <= radius) alpha[i] = Math.round(255 * (1 - dist[i] / (radius + 1)));
  }
  return alpha;
}

function composeFillCrop(session) {
  const candidate = session.candidates?.[session.candidateIndex];
  if (!candidate) return null;
  const alpha = outwardFeatherAlpha(session.mask, session.bounds.cropW, session.bounds.cropH, session.feather);
  const out = session.sourcePixels.slice();
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i];
    if (!a) continue;
    const p = i * 4;
    if (a === 255) {
      out[p] = candidate.pixels[p];
      out[p + 1] = candidate.pixels[p + 1];
      out[p + 2] = candidate.pixels[p + 2];
      out[p + 3] = 255;
    } else {
      const inv = 255 - a;
      out[p] = Math.round((candidate.pixels[p] * a + session.sourcePixels[p] * inv) / 255);
      out[p + 1] = Math.round((candidate.pixels[p + 1] * a + session.sourcePixels[p + 1] * inv) / 255);
      out[p + 2] = Math.round((candidate.pixels[p + 2] * a + session.sourcePixels[p + 2] * inv) / 255);
      out[p + 3] = session.sourcePixels[p + 3];
    }
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { outwardFeatherAlpha, composeFillCrop };
}
