/* Board export encode worker: the crop, resize and encode for one Viewer/PDF
 * image (scripts/board-export-encode.mjs), off the page's thread so the board
 * keeps drawing while an export runs. Driven by createImageResizePool:
 *
 *   in:  { id, blob: Blob, options: job without the blob }
 *   out: { id, result: { blob, mime, w, h, alpha } } | { id, error: string }
 */
import { encodeViewerImage } from './board-export-encode.mjs';

self.onmessage = async ({ data }) => {
  const { id, blob, options } = data || {};
  try {
    const result = await encodeViewerImage({ ...options, blob });
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
