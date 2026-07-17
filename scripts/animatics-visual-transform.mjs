const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finiteOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function normalizedRotation(value) {
  let rotation = finiteOr(value, 0) % 360;
  if (rotation > 180) rotation -= 360;
  if (rotation <= -180) rotation += 360;
  return rotation;
}

export function normalizeBoardTransform(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const crop = raw.crop && typeof raw.crop === 'object' ? raw.crop : {};
  const l = clamp(finiteOr(crop.l, 0), 0, .995);
  const t = clamp(finiteOr(crop.t, 0), 0, .995);
  const r = clamp(finiteOr(crop.r, 1), l + .005, 1);
  const b = clamp(finiteOr(crop.b, 1), t + .005, 1);
  return {
    crop: { l, t, r, b },
    rotation: normalizedRotation(raw.rotation ?? raw.rot),
    flipX: !!raw.flipX,
    flipY: !!raw.flipY,
    gray: !!raw.gray,
    width: Math.max(.001, finiteOr(raw.width ?? raw.w, 1)),
    height: Math.max(.001, finiteOr(raw.height ?? raw.h, 1)),
  };
}

export function boardTransformAssetKey(itemId, rawTransform) {
  const transform = normalizeBoardTransform(rawTransform);
  if (!transform) return String(itemId || 'image');
  const { crop, rotation, flipX, flipY, gray, width, height } = transform;
  return [
    String(itemId || 'image'),
    crop.l, crop.t, crop.r, crop.b, rotation,
    flipX ? 1 : 0, flipY ? 1 : 0, gray ? 1 : 0,
    width, height,
  ].map((value, index) => index === 0 ? value : Number(value).toFixed(6)).join('|');
}

export function visualSourceGeometry(sourceWidth, sourceHeight, rawTransform = null) {
  const sw = Math.max(1, finiteOr(sourceWidth, 1));
  const sh = Math.max(1, finiteOr(sourceHeight, 1));
  const transform = normalizeBoardTransform(rawTransform);
  if (!transform) {
    return {
      transform: null,
      source: { x: 0, y: 0, width: sw, height: sh },
      baseWidth: sw,
      baseHeight: sh,
      rotatedWidth: sw,
      rotatedHeight: sh,
      rotationRadians: 0,
    };
  }
  const { crop } = transform;
  const source = {
    x: crop.l * sw,
    y: crop.t * sh,
    width: Math.max(1, (crop.r - crop.l) * sw),
    height: Math.max(1, (crop.b - crop.t) * sh),
  };
  const baseWidth = transform.width;
  const baseHeight = transform.height;
  const rotationRadians = transform.rotation * Math.PI / 180;
  const cos = Math.abs(Math.cos(rotationRadians));
  const sin = Math.abs(Math.sin(rotationRadians));
  return {
    transform,
    source,
    baseWidth,
    baseHeight,
    rotatedWidth: Math.max(.001, baseWidth * cos + baseHeight * sin),
    rotatedHeight: Math.max(.001, baseWidth * sin + baseHeight * cos),
    rotationRadians,
  };
}

export function framingFitMultiplier(viewWidth, viewHeight, sourceWidth, sourceHeight, fit = 'contain') {
  const vw = Math.max(.001, finiteOr(viewWidth, 1));
  const vh = Math.max(.001, finiteOr(viewHeight, 1));
  const sw = Math.max(.001, finiteOr(sourceWidth, 1));
  const sh = Math.max(.001, finiteOr(sourceHeight, 1));
  return fit === 'cover' ? Math.max(vw / sw, vh / sh) : Math.min(vw / sw, vh / sh);
}

export function effectiveFramingScale(framing, viewWidth, viewHeight, sourceWidth, sourceHeight) {
  const fit = framing?.fit === 'cover' ? 'cover' : 'contain';
  const contain = framingFitMultiplier(viewWidth, viewHeight, sourceWidth, sourceHeight, 'contain');
  const selected = framingFitMultiplier(viewWidth, viewHeight, sourceWidth, sourceHeight, fit);
  return Math.max(.0001, finiteOr(framing?.scale, 1)) * selected / contain;
}

export function framingScaleFromEffective(effectiveScale, framing, viewWidth, viewHeight, sourceWidth, sourceHeight) {
  const fit = framing?.fit === 'cover' ? 'cover' : 'contain';
  const contain = framingFitMultiplier(viewWidth, viewHeight, sourceWidth, sourceHeight, 'contain');
  const selected = framingFitMultiplier(viewWidth, viewHeight, sourceWidth, sourceHeight, fit);
  return Math.max(.0001, finiteOr(effectiveScale, 1)) * contain / selected;
}
