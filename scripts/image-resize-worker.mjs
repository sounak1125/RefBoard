/* Image resize worker.
 *
 * createImageBitmap(blob, { resizeWidth, resizeHeight }) decodes off-thread but
 * then resizes on whichever thread called it. On the page that is the thread
 * that draws the board, so every LOD tier and stable proxy froze drawing for
 * 16-125 ms while the board was zoomed. Here the same call blocks nothing that
 * paints. The Blob arrives as a handle (no bytes are copied) and the bitmap
 * goes back transferred.
 *
 *   in:  { id, blob: Blob, options: ImageBitmapOptions }
 *   out: { id, bitmap: ImageBitmap } | { id, error: string }
 */
self.onmessage = async ({ data }) => {
  const { id, blob, options } = data || {};
  try {
    const bitmap = await createImageBitmap(blob, options);
    self.postMessage({ id, bitmap }, [bitmap]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
