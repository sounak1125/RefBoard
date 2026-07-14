/**
 * Select the highest-priority decoded image surfaces that fit in a pixel budget.
 * The first candidate is always admitted so one oversized image can still sharpen.
 */
export function selectImageRenderDemand(candidates, maxPixels) {
  const budget = Math.max(0, Number(maxPixels) || 0);
  const unique = new Map();

  for (const raw of candidates || []) {
    if (!raw || raw.key == null) continue;
    const key = String(raw.key);
    const pixels = Math.max(1, Number(raw.pixels) || 1);
    const distance = Number.isFinite(raw.distance) ? raw.distance : Number.POSITIVE_INFINITY;
    const current = unique.get(key);
    if (!current || distance < current.distance) unique.set(key, { key, pixels, distance });
  }

  const ordered = [...unique.values()].sort((a, b) =>
    a.distance - b.distance || a.key.localeCompare(b.key));
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
export const IMAGE_FOCUS_UPGRADE_MS = 96;
export const IMAGE_FOCUS_DOWNGRADE_MS = 56;

export function imageTierPixelExtent(tier, sourcePixels) {
  const source = Math.max(1, Number(sourcePixels) || 1);
  return tier === IMAGE_FULL_TIER
    ? source
    : Math.min(source, Math.max(1, Number(tier) || IMAGE_PROXY_TIER));
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
 * Animate a resolution handoff as a short focus pull. Upgrades draw the ready
 * surface with a diminishing blur; downgrades soften the old surface before
 * switching. This avoids alpha/halo artifacts on transparent images.
 */
export function imageFocusTransition({ fromPixels, toPixels, elapsedMs } = {}) {
  const from = Math.max(1, Number(fromPixels) || 1);
  const to = Math.max(1, Number(toPixels) || 1);
  const upgrade = to > from;
  const durationMs = upgrade ? IMAGE_FOCUS_UPGRADE_MS : IMAGE_FOCUS_DOWNGRADE_MS;
  const progress = Math.max(0, Math.min(1, (Number(elapsedMs) || 0) / durationMs));
  if (progress >= 1 || from === to) {
    return { done: true, draw: 'to', blurPx: 0, progress: 1, durationMs };
  }
  const eased = progress * progress * (3 - 2 * progress);
  const ratio = Math.max(from, to) / Math.min(from, to);
  const maxBlurPx = Math.min(1.6, Math.max(0.45, Math.log2(ratio) * 0.55));
  return {
    done: false,
    draw: upgrade ? 'to' : 'from',
    blurPx: upgrade ? maxBlurPx * (1 - eased) : maxBlurPx * eased,
    progress,
    durationMs,
  };
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

  if (navigating) return validPrevious || proxy;

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
