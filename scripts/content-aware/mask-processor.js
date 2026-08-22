'use strict';
/* Mask preprocessing (§25) and algorithm classification (§5).
 *
 * Turns whatever the caller passed — a 0/1 Uint8Array, a 0..255 alpha ramp, or
 * an RGBA mask image — into the two things the rest of the engine wants: a hard
 * binary "reconstruct this" mask, and a soft 0..255 weight for compositing.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp, dilateMask, insideDepth, maskBounds, countMask } = CAF;

  const HARD_THRESHOLD = 128;

  /* Accepts:
   *   - length === total          : 0/1 or 0..255 single channel
   *   - length === total * 4      : RGBA, red channel carries the mask
   * Anything else throws, because silently guessing is how mask-inversion bugs
   * get shipped.
   */
  function normalize(source, width, height) {
    const total = width * height;
    if (!source || typeof source.length !== 'number') throw new Error('Mask is missing');
    const soft = new Uint8Array(total);
    if (source.length === total) {
      for (let i = 0; i < total; i++) {
        const v = source[i];
        soft[i] = v <= 1 ? (v ? 255 : 0) : clamp(v | 0, 0, 255);
      }
    } else if (source.length === total * 4) {
      for (let i = 0; i < total; i++) soft[i] = clamp(source[i * 4] | 0, 0, 255);
    } else {
      throw new Error(`Mask length ${source.length} matches neither ${total} nor ${total * 4}`);
    }
    return soft;
  }

  /* 8-connected labelling with an explicit stack; recursion overflows on the
   * component a large erase produces. Returns labels (0 = background) and a
   * per-label pixel count. */
  function connectedComponents(mask, width, height) {
    const total = width * height;
    const labels = new Int32Array(total);
    const sizes = [0];
    const stack = new Int32Array(total);
    let next = 0;
    for (let start = 0; start < total; start++) {
      if (!mask[start] || labels[start]) continue;
      next++;
      let size = 0;
      let sp = 0;
      stack[sp++] = start;
      labels[start] = next;
      while (sp > 0) {
        const p = stack[--sp];
        size++;
        const px = p % width, py = (p / width) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = px + dx;
            if (nx < 0 || nx >= width) continue;
            const q = ny * width + nx;
            if (!mask[q] || labels[q]) continue;
            labels[q] = next;
            stack[sp++] = q;
          }
        }
      }
      sizes.push(size);
    }
    return { labels, sizes, count: next };
  }

  /* Drops components too small to be anything but a stray click. Scaled off the
   * largest component so a deliberately tiny mask is never wiped out. */
  function despeckle(mask, width, height) {
    const { labels, sizes, count } = connectedComponents(mask, width, height);
    if (count <= 1) return { mask, removed: 0, components: count };
    let largest = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > largest) largest = sizes[i];
    const floor = Math.max(4, Math.round(largest * 0.005));
    let removed = 0;
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) {
      const label = labels[i];
      if (!label) continue;
      if (sizes[label] < floor) { removed++; continue; }
      out[i] = 1;
    }
    // Never hand back an empty mask; if every component looked like a speck the
    // user meant the specks.
    if (!countMask(out)) return { mask, removed: 0, components: count };
    return { mask: out, removed, components: count };
  }

  /* §5. Thin structures — dust, scratches, wires, hairline gaps — are exactly
   * what a diffusion inpainter is good at and exemplar synthesis is wasteful on,
   * because every pixel is already within a patch of known content.
   *
   * The test is the thickest point of the hole, not its area: a long scratch
   * across the whole frame is still a scratch. */
  const THIN_DEPTH = 4;

  function classify(mask, width, height) {
    const depth = insideDepth(mask, width, height);
    let maxDepth = 0;
    let area = 0;
    for (let i = 0; i < depth.length; i++) {
      if (!mask[i]) continue;
      area++;
      if (depth[i] > maxDepth) maxDepth = depth[i];
    }
    const bounds = maskBounds(mask, width, height);
    const algorithm = (area > 0 && maxDepth <= THIN_DEPTH) ? 'telea' : 'patchmatch';
    return { algorithm, area, maxDepth, depth, bounds };
  }

  /* The whole preprocessing chain. `expansion` comes from resolved options. */
  function prepare(source, width, height, options) {
    const opts = options || {};
    const soft = normalize(source, width, height);
    const total = width * height;

    let hard = new Uint8Array(total);
    let anySoft = false;
    for (let i = 0; i < total; i++) {
      if (soft[i] >= HARD_THRESHOLD) hard[i] = 1;
      else if (soft[i] > 0) anySoft = true;
    }
    // A mask made entirely of soft values still has to reconstruct something.
    if (!countMask(hard) && anySoft) {
      for (let i = 0; i < total; i++) if (soft[i] > 0) hard[i] = 1;
    }
    if (!countMask(hard)) throw new Error('The fill mask is empty');

    let removed = 0;
    let components = 1;
    if (opts.despeckle !== false) {
      const cleaned = despeckle(hard, width, height);
      hard = cleaned.mask;
      removed = cleaned.removed;
      components = cleaned.components;
    }

    const expansion = clamp(opts.maskExpansion | 0, 0, 64);
    const expanded = expansion > 0 ? dilateMask(hard, width, height, expansion) : hard;

    const info = classify(expanded, width, height);
    if (!info.area) throw new Error('The fill mask is empty after preprocessing');

    return {
      soft,
      hard,
      fill: expanded,
      expansion,
      speckRemoved: removed,
      components,
      algorithm: info.algorithm,
      area: info.area,
      maxDepth: info.maxDepth,
      depth: info.depth,
      bounds: info.bounds,
    };
  }

  CAF.maskProcessor = {
    HARD_THRESHOLD,
    THIN_DEPTH,
    normalize,
    connectedComponents,
    despeckle,
    classify,
    prepare,
  };
})(typeof self !== 'undefined' ? self : globalThis);
