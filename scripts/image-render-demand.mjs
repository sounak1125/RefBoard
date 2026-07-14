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
