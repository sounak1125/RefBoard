/**
 * Re-encodes one image for the Viewer / PDF export: crop to a source-pixel
 * rect, resize to (w, h), then PNG when lossless is asked for, else JPEG for
 * opaque pixels or WebP when any pixel has alpha. Runs in
 * scripts/board-export-encode-worker.mjs; the page imports it only as the
 * pool's fallback when workers are unavailable.
 *
 *   job: { blob, rect: {x, y, w, h}, w, h, opaque, lossless, jpegQuality, alphaQuality }
 *   ->   { blob, mime, w, h, alpha }   (alpha is null for a lossless PNG)
 */
export async function encodeViewerImage({ blob, rect, w, h, opaque = false, lossless = false, jpegQuality = 0.9, alphaQuality = 0.9 }) {
  const bitmap = await createImageBitmap(blob, rect.x, rect.y, rect.w, rect.h, {
    resizeWidth: w, resizeHeight: h, resizeQuality: 'high',
  });
  try {
    const canvas = new OffscreenCanvas(w, h);
    const g = canvas.getContext('2d', { willReadFrequently: !opaque && !lossless });
    g.drawImage(bitmap, 0, 0);
    if (lossless) {
      const out = await canvas.convertToBlob({ type: 'image/png' });
      return { blob: out, mime: out.type || 'image/png', w, h, alpha: null };
    }
    let alpha = false;
    if (!opaque) {
      const data = g.getImageData(0, 0, w, h).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] !== 255) { alpha = true; break; }
      }
    }
    const out = alpha
      ? await canvas.convertToBlob({ type: 'image/webp', quality: alphaQuality })
      : await canvas.convertToBlob({ type: 'image/jpeg', quality: jpegQuality });
    return { blob: out, mime: out.type || (alpha ? 'image/webp' : 'image/jpeg'), w, h, alpha };
  } finally {
    bitmap.close?.();
  }
}
