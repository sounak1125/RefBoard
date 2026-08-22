'use strict';
/* Confidence map (§14) and boundary-first ordering (§15).
 *
 * Confidence is what keeps §35 honest: original photograph is trusted at 1.0,
 * a freshly reconstructed pixel starts near 0, and it only earns trust as the
 * patches voting for it agree with each other. Scoring reads it so that a patch
 * overlapping half-finished reconstruction is judged on the part that is real.
 */
(function (root) {
  const CAF = root.CAF = root.CAF || {};
  const { clamp } = CAF;

  /* Hole pixels sorted by distance to the nearest known pixel, nearest first.
   * Pixels close to a boundary carry the most information, so structure flows
   * outside-in rather than being decided in the middle of the hole. */
  function fillOrder(mask, width, height, depth) {
    const d = depth || CAF.insideDepth(mask, width, height);
    const hole = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) hole.push(i);
    hole.sort((a, b) => d[a] - d[b]);
    return { order: Int32Array.from(hole), depth: d };
  }

  function create(mask, width, height) {
    const total = width * height;
    const map = new Float32Array(total);
    for (let i = 0; i < total; i++) map[i] = mask[i] ? 0 : 1;
    return map;
  }

  /* Seeds hole confidence from depth alone, before anything has been matched.
   * A pixel one step from real content is a far better bet than one in the
   * middle of a large erase, and the search should know that from iteration
   * zero rather than discovering it. */
  function seedFromDepth(map, mask, depth, maxDepth) {
    const span = Math.max(1, maxDepth);
    for (let i = 0; i < map.length; i++) {
      if (!mask[i]) { map[i] = 1; continue; }
      map[i] = clamp(0.35 * (1 - depth[i] / span), 0, 0.35);
    }
    return map;
  }

  /* After a voting pass: agreement is how concentrated the vote was (weight of
   * the winning patch over total weight), cost is the winning patch distance.
   * A pixel rebuilt from many patches that all said the same thing is reliable;
   * one rebuilt from a scatter of disagreeing patches is not.
   *
   * Confidence only ever rises. A later pass that happens to vote badly should
   * not un-learn what an earlier one established, or the search oscillates. */
  function update(map, mask, agreement, cost, sigma2) {
    const s2 = sigma2 > 1e-6 ? sigma2 : 1;
    for (let i = 0; i < map.length; i++) {
      if (!mask[i]) { map[i] = 1; continue; }
      const quality = Math.exp(-cost[i] / (2 * s2));
      const next = clamp(0.9 * agreement[i] * quality, 0, 0.95);
      if (next > map[i]) map[i] = next;
    }
    return map;
  }

  /* Mean confidence across the hole — the headline number §34 reports. */
  function summarize(map, mask) {
    let sum = 0, n = 0, worst = 1;
    for (let i = 0; i < map.length; i++) {
      if (!mask[i]) continue;
      sum += map[i];
      if (map[i] < worst) worst = map[i];
      n++;
    }
    return { mean: n ? sum / n : 0, worst: n ? worst : 0, count: n };
  }

  /* Upsamples a confidence map between pyramid levels by nearest neighbour.
   * Bilinear would invent trust at pixels that have not been solved yet. */
  function upsample(map, fromW, fromH, toW, toH) {
    const out = new Float32Array(toW * toH);
    const sx = fromW / toW;
    const sy = fromH / toH;
    for (let y = 0; y < toH; y++) {
      const src = Math.min(fromH - 1, (y * sy) | 0) * fromW;
      const dst = y * toW;
      for (let x = 0; x < toW; x++) {
        out[dst + x] = map[src + Math.min(fromW - 1, (x * sx) | 0)];
      }
    }
    return out;
  }

  CAF.confidence = {
    fillOrder,
    create,
    seedFromDepth,
    update,
    summarize,
    upsample,
  };
})(typeof self !== 'undefined' ? self : globalThis);
