/**
 * Screen distance an incumbent surface is worth. Demand distances are squared
 * pixels, so this is squared before use. Ranking is recomputed every frame from
 * a live view, and pointer-anchored zoom reshuffles it continuously; without a
 * bias toward what was already admitted, images sitting on the budget boundary
 * flip in and out frame to frame and visibly pop between tiers.
 */
export const IMAGE_DEMAND_STICKY_PX = 220;

/**
 * Select the highest-priority decoded image surfaces that fit in a pixel budget.
 * The first candidate is always admitted so one oversized image can still sharpen.
 *
 * `previous` is the prior frame's selection. Its members rank as though they
 * were `stickyPx` closer, so an incumbent yields only to a meaningfully nearer
 * challenger. The bias is additive because callers encode selection and
 * pointer-focus priority as large negative distances; a multiplier would invert
 * those.
 */
export function selectImageRenderDemand(candidates, maxPixels, {
  previous = null,
  stickyPx = IMAGE_DEMAND_STICKY_PX,
} = {}) {
  const budget = Math.max(0, Number(maxPixels) || 0);
  const sticky = previous?.size ? Math.max(0, Number(stickyPx) || 0) ** 2 : 0;
  const unique = new Map();

  for (const raw of candidates || []) {
    if (!raw || raw.key == null) continue;
    const key = String(raw.key);
    const pixels = Math.max(1, Number(raw.pixels) || 1);
    const distance = Number.isFinite(raw.distance) ? raw.distance : Number.POSITIVE_INFINITY;
    const current = unique.get(key);
    if (!current || distance < current.distance) unique.set(key, { key, pixels, distance });
  }

  const rank = c => (sticky && previous.has(c.key) ? c.distance - sticky : c.distance);
  const ordered = [...unique.values()].sort((a, b) =>
    rank(a) - rank(b) || a.key.localeCompare(b.key));
  const selected = new Set();
  let usedPixels = 0;

  for (const candidate of ordered) {
    if (selected.size && usedPixels + candidate.pixels > budget) continue;
    selected.add(candidate.key);
    usedPixels += candidate.pixels;
  }

  return { selected, usedPixels };
}

export const IMAGE_PROXY_TIER = 256;
export const IMAGE_DYNAMIC_TIERS = Object.freeze([512, 1024, 2048]);
export const IMAGE_FULL_TIER = 'full';
export const IMAGE_NAV_PREWARM_DELAY_MS = 48;

export function imageTierPixelExtent(tier, sourcePixels) {
  const source = Math.max(1, Number(sourcePixels) || 1);
  return tier === IMAGE_FULL_TIER
    ? source
    : Math.min(source, Math.max(1, Number(tier) || IMAGE_PROXY_TIER));
}

/**
 * Navigation may reveal a sharper surface as soon as it is decoded, but must
 * never switch to a softer tier mid-gesture. Downgrades remain deferred until
 * the view settles, when their smaller on-screen size makes the swap harmless.
 */
export function shouldPromoteReadyImageTier({
  currentTier = IMAGE_PROXY_TIER,
  desiredTier = IMAGE_PROXY_TIER,
  sourcePixels,
  ready = false,
} = {}) {
  if (!ready) return false;
  return imageTierPixelExtent(desiredTier, sourcePixels)
    > imageTierPixelExtent(currentTier, sourcePixels);
}

/** Keep rapidly changing zoom targets from filling the decode queue with stale work. */
export function updateImagePrewarmState({
  previousTier = null,
  previousSince = 0,
  nextTier,
  now = 0,
  delayMs = IMAGE_NAV_PREWARM_DELAY_MS,
} = {}) {
  const time = Math.max(0, Number(now) || 0);
  if (nextTier !== previousTier) return { tier: nextTier, since: time, ready: false };
  const since = Math.max(0, Number(previousSince) || 0);
  return { tier: nextTier, since, ready: time - since >= Math.max(0, Number(delayMs) || 0) };
}

/**
 * Pick a decoded surface from the image's physical on-screen long edge.
 * Navigation freezes an existing target; hysteresis prevents boundary chatter.
 */
export function selectScreenImageTier({
  requiredPixels,
  sourcePixels,
  previousTier = null,
  navigating = false,
  proxyTier = IMAGE_PROXY_TIER,
  dynamicTiers = IMAGE_DYNAMIC_TIERS,
  upgradeRatio = 1.1,
  downgradeRatio = 0.85,
} = {}) {
  const required = Math.max(1, Number(requiredPixels) || 1);
  const source = Math.max(1, Number(sourcePixels) || 1);
  const tiers = [proxyTier, ...dynamicTiers].filter((x, i, a) =>
    Number.isFinite(x) && x > 0 && a.indexOf(x) === i).sort((a, b) => a - b);
  const proxy = tiers[0] || IMAGE_PROXY_TIER;
  const validPrevious = previousTier === IMAGE_FULL_TIER || tiers.includes(previousTier)
    ? previousTier
    : null;

  // The freeze exists to prevent a mid-gesture downgrade. An item with no
  // displayed tier has nothing to protect, so pinning it to the proxy only
  // delays its first real surface until the wheel settles.
  if (navigating && validPrevious) return validPrevious;

  let nominal = tiers.find(tier => required <= tier) || IMAGE_FULL_TIER;
  if (nominal !== proxy && nominal !== IMAGE_FULL_TIER && nominal >= source) nominal = IMAGE_FULL_TIER;
  if (nominal === IMAGE_FULL_TIER && source <= proxy) nominal = proxy;
  if (!validPrevious || nominal === validPrevious) return nominal;

  const rank = tier => tier === IMAGE_FULL_TIER ? tiers.length : tiers.indexOf(tier);
  const previousRank = rank(validPrevious);
  const nominalRank = rank(nominal);

  if (nominalRank > previousRank) {
    const previousPixels = validPrevious === IMAGE_FULL_TIER ? source : validPrevious;
    if (required <= previousPixels * upgradeRatio) return validPrevious;
    return nominal;
  }

  const lowerAdjacent = tiers[Math.max(0, previousRank - 1)] || proxy;
  if (required >= lowerAdjacent * downgradeRatio) return validPrevious;
  return nominal;
}
