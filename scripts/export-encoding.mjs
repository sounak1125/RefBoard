/**
 * Which encoder an exported or dragged-out image goes through.
 * Used by index.html and scripts/test-cropped-export.mjs.
 *
 * An untouched image never reaches here — it hands over its stored bytes. This
 * only decides what happens when a crop, rotation, flip or greyscale has forced
 * the pixels through a canvas and they have to be encoded again.
 */

/* High enough that the loss is invisible, low enough to stay a normal-sized
   file. Only used when the user explicitly asked for a lossy format. */
export const LOSSY_QUALITY = 0.98;

export function exportEncoding(format, sourceType) {
  // An explicit format choice is the user asking for that format, loss included.
  if (format === 'png') return { mime: 'image/png', ext: 'png', quality: undefined };
  if (format === 'jpeg') return { mime: 'image/jpeg', ext: 'jpg', quality: LOSSY_QUALITY };
  if (format === 'webp') return { mime: 'image/webp', ext: 'webp', quality: LOSSY_QUALITY };

  /* Only 'original' reaches here, and "original" has to mean "no pixels lost".
     Re-encoding a JPEG at any quality adds a generation of loss to pixels the
     user asked to keep as they are, so a lossy source is never re-encoded
     lossily:

       - WebP keeps its own format. Chromium's encoder is genuinely lossless at
         quality 1 — a 256x256 noise image round-trips with zero changed
         channels, and lands smaller than the same image as PNG.
       - JPEG becomes a PNG. Chromium has no lossless JPEG mode, so the format
         has to change for the pixels to survive. The file gets bigger; the
         image does not get worse.
       - GIF/SVG/BMP/AVIF have no reliable canvas encoder and already fell
         back to PNG.

     Both are lossless, so neither carries a quality argument. */
  if (sourceType === 'image/webp') return { mime: 'image/webp', ext: 'webp', quality: 1 };
  return { mime: 'image/png', ext: 'png', quality: undefined };
}
