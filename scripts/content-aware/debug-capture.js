'use strict';
/* Developer visualisation (§33).
 *
 * Off by default and a no-op when off, so the hot path pays nothing. When on,
 * every intermediate the engine produces is converted to a plain RGBA preview
 * that can be written straight out as an image — which is the only practical way
 * to diagnose why a particular fill came out wrong.
 *
 * This is never exposed in the normal interface.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp } = CAF;

  function create(enabled) {
    if (!enabled) {
      // Same shape, all no-ops.
      return {
        enabled: false,
        rgba() {}, scalar() {}, mask() {}, nnf() {}, note() {},
        result() { return null; },
      };
    }

    const layers = [];
    const notes = {};

    const push = (name, width, height, data) => {
      layers.push({ name, width, height, data });
    };

    return {
      enabled: true,

      /* An RGBA buffer, copied so later passes cannot mutate the capture. */
      rgba(name, pixels, width, height) {
        push(name, width, height, new Uint8ClampedArray(pixels));
      },

      /* A scalar plane rendered as greyscale. `hi` fixes the white point; when
       * omitted the plane's own maximum is used, which is right for cost maps
       * and wrong for anything already normalised. */
      scalar(name, values, width, height, hi) {
        let top = hi;
        if (top === undefined) {
          top = 0;
          for (let i = 0; i < values.length; i++) {
            const v = values[i];
            if (Number.isFinite(v) && v > top) top = v;
          }
        }
        const scale = top > 1e-9 ? 255 / top : 0;
        const out = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          const v = Number.isFinite(values[i]) ? clamp(values[i] * scale, 0, 255) : 255;
          const p = i * 4;
          out[p] = out[p + 1] = out[p + 2] = v;
          out[p + 3] = 255;
        }
        push(name, width, height, out);
      },

      mask(name, values, width, height) {
        const out = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          const v = values[i] ? 255 : 0;
          const p = i * 4;
          out[p] = out[p + 1] = out[p + 2] = v;
          out[p + 3] = 255;
        }
        push(name, width, height, out);
      },

      /* Offsets as colour: red carries dx, green carries dy, blue marks pixels
       * with no match at all. Regions of one flat colour are one contiguous
       * source region, so this is the fastest way to see whether the field went
       * fragmented. */
      nnf(name, field, mask, width, height) {
        const out = new Uint8ClampedArray(width * height * 4);
        let span = 1;
        for (let i = 0; i < width * height; i++) {
          if (!mask[i] || field.x[i] < 0) continue;
          span = Math.max(span, Math.abs(field.x[i] - (i % width)), Math.abs(field.y[i] - ((i / width) | 0)));
        }
        for (let i = 0; i < width * height; i++) {
          const p = i * 4;
          out[p + 3] = 255;
          if (!mask[i]) continue;
          if (field.x[i] < 0) { out[p + 2] = 255; continue; }
          out[p] = clamp(128 + 127 * (field.x[i] - (i % width)) / span, 0, 255);
          out[p + 1] = clamp(128 + 127 * (field.y[i] - ((i / width) | 0)) / span, 0, 255);
        }
        push(name, width, height, out);
      },

      note(key, value) { notes[key] = value; },

      result() {
        return { layers, notes };
      },
    };
  }

  CAF.debugCapture = { create };
})(typeof self !== 'undefined' ? self : globalThis);
