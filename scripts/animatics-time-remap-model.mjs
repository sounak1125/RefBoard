const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export const TIME_REMAP_MODEL_VERSION = 2;
export const MIN_TIME_REMAP_SPEED = .01;
export const MAX_TIME_REMAP_SPEED = 100;
export const MAX_TIME_REMAP_KEYFRAMES = 64;

const INTERPOLATIONS = new Set(['linear', 'bezier', 'continuous', 'auto', 'hold']);

function mediaSpan(item) {
  const sourceIn = Math.max(0, finite(item?.sourceIn));
  const sourceOut = Math.max(sourceIn, finite(item?.sourceOut, sourceIn + Math.max(0, finite(item?.duration))));
  return Math.max(0, sourceOut - sourceIn);
}

function interpolation(value, fallback = 'bezier') {
  return INTERPOLATIONS.has(value) ? value : fallback;
}

function rawHandle(value) {
  if (!value || typeof value !== 'object') return null;
  return { dt: finite(value.dt), dv: finite(value.dv) };
}

function isCanonical(raw) {
  return Number(raw?.modelVersion) >= TIME_REMAP_MODEL_VERSION
    || raw?.keyframes?.some(point => point?.inHandle || point?.outHandle || point?.inInterpolation || point?.outInterpolation);
}

function makeRawPoints(item, raw) {
  const duration = Math.max(1e-8, finite(item?.duration));
  const span = mediaSpan(item);
  const legacy = !isCanonical(raw);
  const reverse = legacy && raw?.reverse === true;
  const source = Array.isArray(raw?.keyframes) ? raw.keyframes.slice(0, MAX_TIME_REMAP_KEYFRAMES) : [];
  const points = source.map(point => {
    const legacyValue = clamp(finite(point?.value), 0, span);
    return {
      time: clamp(finite(point?.time), 0, duration),
      value: reverse ? span - legacyValue : legacyValue,
      inHandle: rawHandle(point?.inHandle),
      outHandle: rawHandle(point?.outHandle),
      inInterpolation: interpolation(point?.inInterpolation, raw?.curve === 'linear' ? 'linear' : 'bezier'),
      outInterpolation: interpolation(point?.outInterpolation, raw?.curve === 'linear' ? 'linear' : 'bezier'),
      continuous: point?.continuous !== false,
      autoBezier: point?.autoBezier === true,
      legacySpeed: legacy && Number.isFinite(Number(point?.speed)) ? (reverse ? -1 : 1) * Math.max(0, finite(point.speed)) : null,
    };
  }).filter(point => Number.isFinite(point.time) && Number.isFinite(point.value))
    .sort((a, b) => a.time - b.time || a.value - b.value);

  const fallbackSlope = span / duration || 1;
  if (!points.length || points[0].time > 1e-8) points.unshift({
    time: 0, value: reverse ? span : 0, inHandle: null, outHandle: null,
    inInterpolation: 'bezier', outInterpolation: raw?.curve === 'linear' ? 'linear' : 'bezier',
    continuous: true, autoBezier: false, legacySpeed: reverse ? -fallbackSlope : fallbackSlope,
  });
  if (points.length === 1 || points.at(-1).time < duration - 1e-8) points.push({
    time: duration, value: reverse ? 0 : span, inHandle: null, outHandle: null,
    inInterpolation: raw?.curve === 'linear' ? 'linear' : 'bezier', outInterpolation: 'bezier',
    continuous: true, autoBezier: false, legacySpeed: reverse ? -fallbackSlope : fallbackSlope,
  });

  const unique = [];
  for (const point of points) {
    if (unique.length && Math.abs(unique.at(-1).time - point.time) < 1e-8) unique[unique.length - 1] = point;
    else unique.push(point);
  }
  if (unique.length < 2) unique.push({ ...unique[0], time: duration, value: reverse ? 0 : span });
  unique[0].time = 0;
  unique.at(-1).time = duration;
  return unique;
}

function autoSlope(points, index) {
  const point = points[index], before = points[index - 1], after = points[index + 1];
  if (!before && !after) return 0;
  if (!before) return (after.value - point.value) / Math.max(1e-8, after.time - point.time);
  if (!after) return (point.value - before.value) / Math.max(1e-8, point.time - before.time);
  return (after.value - before.value) / Math.max(1e-8, after.time - before.time);
}

function normalizedHandle(point, side, neighbor, span, defaultSlope) {
  if (!neighbor) return { dt: 0, dv: 0 };
  const direction = side === 'in' ? -1 : 1;
  const segmentDuration = Math.max(1e-8, Math.abs(neighbor.time - point.time));
  const supplied = point[`${side}Handle`];
  let dt = supplied ? finite(supplied.dt) : direction * segmentDuration / 3;
  dt = direction * clamp(Math.abs(dt), segmentDuration * .002, segmentDuration * .95);
  const slope = point.legacySpeed ?? defaultSlope;
  let dv = supplied ? finite(supplied.dv) : slope * dt;
  dv = clamp(dv, -MAX_TIME_REMAP_SPEED * Math.abs(dt), MAX_TIME_REMAP_SPEED * Math.abs(dt));
  dv = clamp(point.value + dv, 0, span) - point.value;
  return { dt, dv };
}

function normalizeHandles(points, span) {
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const slope = point.autoBezier ? autoSlope(points, index) : point.legacySpeed;
    const inDefault = slope ?? (index ? (point.value - points[index - 1].value) / Math.max(1e-8, point.time - points[index - 1].time) : autoSlope(points, index));
    const outDefault = slope ?? (index < points.length - 1 ? (points[index + 1].value - point.value) / Math.max(1e-8, points[index + 1].time - point.time) : autoSlope(points, index));
    point.inHandle = normalizedHandle(point, 'in', points[index - 1], span, inDefault);
    point.outHandle = normalizedHandle(point, 'out', points[index + 1], span, outDefault);
    if (point.autoBezier) {
      point.inInterpolation = point.inInterpolation === 'hold' ? 'hold' : 'auto';
      point.outInterpolation = point.outInterpolation === 'hold' ? 'hold' : 'auto';
    }
    delete point.legacySpeed;
  }
  for (let index = 0; index < points.length - 1; index++) {
    const from = points[index], to = points[index + 1], duration = to.time - from.time;
    const used = from.outHandle.dt + Math.abs(to.inHandle.dt);
    if (used > duration * .98) {
      const scale = duration * .98 / used;
      from.outHandle.dt *= scale; from.outHandle.dv *= scale;
      to.inHandle.dt *= scale; to.inHandle.dv *= scale;
    }
  }
  return points;
}

export function normalizeTimeRemap(item, raw = item?.timeRemap) {
  const points = normalizeHandles(makeRawPoints(item, raw), mediaSpan(item));
  const deltas = points.slice(1).map((point, index) => point.value - points[index].value);
  const reverse = deltas.some(delta => delta < -1e-8) && !deltas.some(delta => delta > 1e-8);
  return {
    modelVersion: TIME_REMAP_MODEL_VERSION,
    enabled: raw?.enabled === true,
    reverse,
    preservePitch: raw?.preservePitch !== false,
    ripple: raw?.ripple === true,
    frameInterpolation: ['sampling', 'blending', 'optical-flow'].includes(raw?.frameInterpolation) ? raw.frameInterpolation : 'sampling',
    graphMode: raw?.graphMode === 'value' ? 'value' : 'speed',
    showReferenceGraph: raw?.showReferenceGraph !== false,
    snapToFrames: raw?.snapToFrames !== false,
    keyframes: points,
  };
}

function segmentFor(remap, localTime) {
  const points = remap.keyframes;
  const time = clamp(finite(localTime), 0, points.at(-1)?.time || 0);
  let index = points.length - 2;
  for (let cursor = 0; cursor < points.length - 1; cursor++) {
    if (time <= points[cursor + 1].time + 1e-10) { index = cursor; break; }
  }
  return { from: points[index], to: points[index + 1], index, time };
}

function effectiveHandle(point, side, other) {
  const type = side === 'out' ? point.outInterpolation : point.inInterpolation;
  const duration = Math.max(1e-8, Math.abs(other.time - point.time));
  if (type === 'linear') {
    const dt = (other.time - point.time) / 3;
    return { dt, dv: (other.value - point.value) / 3 };
  }
  return point[`${side}Handle`] || { dt: (other.time - point.time) / 3, dv: (other.value - point.value) / 3 };
}

function segmentControls(from, to) {
  const out = effectiveHandle(from, 'out', to), incoming = effectiveHandle(to, 'in', from);
  return [
    { x: from.time, y: from.value },
    { x: from.time + out.dt, y: from.value + out.dv },
    { x: to.time + incoming.dt, y: to.value + incoming.dv },
    { x: to.time, y: to.value },
  ];
}

function cubic(a, b, c, d, u) {
  const v = 1 - u;
  return v * v * v * a + 3 * v * v * u * b + 3 * v * u * u * c + u * u * u * d;
}

function cubicDerivative(a, b, c, d, u) {
  const v = 1 - u;
  return 3 * v * v * (b - a) + 6 * v * u * (c - b) + 3 * u * u * (d - c);
}

function parameterAtTime(controls, time) {
  const [a, b, c, d] = controls;
  let low = 0, high = 1, u = clamp((time - a.x) / Math.max(1e-8, d.x - a.x), 0, 1);
  for (let iteration = 0; iteration < 10; iteration++) {
    const x = cubic(a.x, b.x, c.x, d.x, u), dx = cubicDerivative(a.x, b.x, c.x, d.x, u);
    if (Math.abs(x - time) < 1e-9) return u;
    if (x < time) low = u; else high = u;
    const candidate = Math.abs(dx) > 1e-9 ? u - (x - time) / dx : NaN;
    u = Number.isFinite(candidate) && candidate > low && candidate < high ? candidate : (low + high) / 2;
  }
  return u;
}

function segmentValueAndSpeed(remap, localTime) {
  const { from, to, index, time } = segmentFor(remap, localTime);
  if (from.outInterpolation === 'hold') return { value: Math.abs(time - to.time) < 1e-9 ? to.value : from.value, speed: 0, index, u: 0 };
  if (from.outInterpolation === 'linear' && to.inInterpolation === 'linear') {
    const speed = (to.value - from.value) / Math.max(1e-8, to.time - from.time);
    return { value: from.value + (time - from.time) * speed, speed, index, u: (time - from.time) / Math.max(1e-8, to.time - from.time) };
  }
  const controls = segmentControls(from, to), u = parameterAtTime(controls, time);
  const dx = cubicDerivative(controls[0].x, controls[1].x, controls[2].x, controls[3].x, u);
  const dy = cubicDerivative(controls[0].y, controls[1].y, controls[2].y, controls[3].y, u);
  return { value: cubic(controls[0].y, controls[1].y, controls[2].y, controls[3].y, u), speed: Math.abs(dx) < 1e-9 ? 0 : dy / dx, index, u };
}

export function timeRemapValueAt(item, localTime) {
  return segmentValueAndSpeed(normalizeTimeRemap(item), localTime).value;
}

export function timeRemapSpeedAt(item, localTime) {
  return segmentValueAndSpeed(normalizeTimeRemap(item), localTime).speed;
}

export function timeRemapSourceAt(item, localTime) {
  const sourceIn = Math.max(0, finite(item?.sourceIn));
  return sourceIn + clamp(timeRemapValueAt(item, localTime), 0, mediaSpan(item));
}

export function timeRemapHandleInfo(item, index) {
  const remap = normalizeTimeRemap(item), point = remap.keyframes[index];
  if (!point) return null;
  const info = side => {
    const handle = point[`${side}Handle`], neighbor = remap.keyframes[index + (side === 'in' ? -1 : 1)];
    if (!neighbor || !handle || Math.abs(handle.dt) < 1e-9) return { speed: 0, influence: 0 };
    return {
      speed: handle.dv / handle.dt,
      influence: Math.abs(handle.dt) / Math.max(1e-8, Math.abs(neighbor.time - point.time)) * 100,
    };
  };
  return { in: info('in'), out: info('out') };
}

export function averageTimeRemapSpeed(item) {
  const duration = Math.max(1e-8, finite(item?.duration));
  return (timeRemapSourceAt(item, duration) - timeRemapSourceAt(item, 0)) / duration;
}

export function hasVariableTimeRemap(item) {
  const remap = normalizeTimeRemap(item);
  if (!remap.enabled) return false;
  const samples = timeRemapSamples({ ...item, timeRemap: remap }, 24), first = samples[0]?.speed || 0;
  return samples.some(sample => Math.abs(sample.speed - first) > 1e-4);
}

export function constantTimeRemap(item, speed = 1, options = {}) {
  const span = mediaSpan(item), signed = clamp(finite(speed, 1), -MAX_TIME_REMAP_SPEED, MAX_TIME_REMAP_SPEED);
  const magnitude = clamp(Math.abs(signed), MIN_TIME_REMAP_SPEED, MAX_TIME_REMAP_SPEED);
  const duration = Math.max(1e-8, Number.isFinite(Number(options.duration)) ? Number(options.duration) : span / magnitude);
  const reverse = options.reverse === true || signed < 0, actual = (span / duration || magnitude) * (reverse ? -1 : 1);
  const startValue = reverse ? span : 0, endValue = reverse ? 0 : span;
  return {
    duration,
    timeRemap: normalizeTimeRemap({ ...item, duration }, {
      modelVersion: TIME_REMAP_MODEL_VERSION,
      enabled: options.enabled !== false,
      preservePitch: options.preservePitch !== false,
      ripple: options.ripple === true,
      frameInterpolation: options.frameInterpolation,
      graphMode: options.graphMode,
      keyframes: [
        { time: 0, value: startValue, outHandle: { dt: duration / 3, dv: actual * duration / 3 }, inInterpolation: 'linear', outInterpolation: 'linear' },
        { time: duration, value: endValue, inHandle: { dt: -duration / 3, dv: -actual * duration / 3 }, inInterpolation: 'linear', outInterpolation: 'linear' },
      ],
    }),
  };
}

export function reverseTimeRemap(item) {
  const remap = normalizeTimeRemap(item), span = mediaSpan(item);
  return normalizeTimeRemap(item, {
    ...remap,
    keyframes: remap.keyframes.map(point => ({
      ...point,
      value: span - point.value,
      inHandle: { ...point.inHandle, dv: -point.inHandle.dv },
      outHandle: { ...point.outHandle, dv: -point.outHandle.dv },
    })),
  });
}

export function retimeCurveToDuration(item, requestedDuration) {
  const oldDuration = Math.max(1e-8, finite(item?.duration)), duration = Math.max(1e-8, finite(requestedDuration, oldDuration));
  const scale = duration / oldDuration, current = normalizeTimeRemap(item);
  return {
    duration,
    timeRemap: normalizeTimeRemap({ ...item, duration }, {
      ...current, enabled: true,
      keyframes: current.keyframes.map(point => ({
        ...point, time: point.time * scale,
        inHandle: { dt: point.inHandle.dt * scale, dv: point.inHandle.dv },
        outHandle: { dt: point.outHandle.dt * scale, dv: point.outHandle.dv },
      })),
    }),
  };
}

function splitCubic(controls, u) {
  const mix = (a, b) => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
  const a = mix(controls[0], controls[1]), b = mix(controls[1], controls[2]), c = mix(controls[2], controls[3]);
  const d = mix(a, b), e = mix(b, c), point = mix(d, e);
  return { left: [controls[0], a, d, point], right: [point, e, c, controls[3]], point };
}

export function addTimeRemapKeyframe(item, localTime) {
  const remap = normalizeTimeRemap(item), duration = Math.max(1e-8, finite(item?.duration)), time = clamp(finite(localTime), 0, duration);
  if (time <= 1e-8 || time >= duration - 1e-8 || remap.keyframes.some(point => Math.abs(point.time - time) < 1e-5)) return remap;
  const segment = segmentFor(remap, time);
  if (segment.from.outInterpolation === 'hold') {
    const points = remap.keyframes.map(point => ({ ...point, inHandle: { ...point.inHandle }, outHandle: { ...point.outHandle } }));
    points.splice(segment.index + 1, 0, {
      time, value: segment.from.value,
      inHandle: { dt: -Math.max(1e-8, time - segment.from.time) / 3, dv: 0 },
      outHandle: { dt: Math.max(1e-8, segment.to.time - time) / 3, dv: 0 },
      inInterpolation: 'hold', outInterpolation: 'hold', continuous: false, autoBezier: false,
    });
    return normalizeTimeRemap(item, { ...remap, enabled: true, keyframes: points });
  }
  const controls = segmentControls(segment.from, segment.to), u = parameterAtTime(controls, time), split = splitCubic(controls, u);
  const points = remap.keyframes.map(point => ({ ...point, inHandle: { ...point.inHandle }, outHandle: { ...point.outHandle } }));
  const left = points[segment.index], right = points[segment.index + 1], center = split.point;
  left.outHandle = { dt: split.left[1].x - left.time, dv: split.left[1].y - left.value };
  right.inHandle = { dt: split.right[2].x - right.time, dv: split.right[2].y - right.value };
  points.splice(segment.index + 1, 0, {
    time: center.x, value: center.y,
    inHandle: { dt: split.left[2].x - center.x, dv: split.left[2].y - center.y },
    outHandle: { dt: split.right[1].x - center.x, dv: split.right[1].y - center.y },
    inInterpolation: segment.from.outInterpolation,
    outInterpolation: segment.to.inInterpolation,
    continuous: true, autoBezier: false,
  });
  return normalizeTimeRemap(item, { ...remap, enabled: true, keyframes: points });
}

export function updateTimeRemapKeyframe(item, index, patch = {}) {
  const remap = normalizeTimeRemap(item), points = remap.keyframes.map(point => ({ ...point, inHandle: { ...point.inHandle }, outHandle: { ...point.outHandle } }));
  if (index < 0 || index >= points.length) return remap;
  const point = points[index], endpoint = index === 0 || index === points.length - 1;
  if (!endpoint && Number.isFinite(Number(patch.time))) point.time = clamp(Number(patch.time), points[index - 1].time + 1e-4, points[index + 1].time - 1e-4);
  if (Number.isFinite(Number(patch.value))) {
    const delta = clamp(Number(patch.value), 0, mediaSpan(item)) - point.value;
    point.value += delta;
  }
  if (patch.continuous !== undefined) point.continuous = patch.continuous === true;
  if (patch.autoBezier !== undefined) point.autoBezier = patch.autoBezier === true;
  if (patch.inInterpolation) point.inInterpolation = interpolation(patch.inInterpolation, point.inInterpolation);
  if (patch.outInterpolation) point.outInterpolation = interpolation(patch.outInterpolation, point.outInterpolation);
  let next = normalizeTimeRemap(item, { ...remap, enabled: true, keyframes: points });
  if (Number.isFinite(Number(patch.speed))) {
    next = updateTimeRemapHandle({ ...item, timeRemap: next }, index, 'in', { speed: Number(patch.speed) });
    next = updateTimeRemapHandle({ ...item, timeRemap: next }, index, 'out', { speed: Number(patch.speed) });
  }
  return next;
}

export function updateTimeRemapHandle(item, index, side, patch = {}) {
  const remap = normalizeTimeRemap(item), points = remap.keyframes.map(point => ({ ...point, inHandle: { ...point.inHandle }, outHandle: { ...point.outHandle } }));
  const point = points[index], offset = side === 'in' ? -1 : side === 'out' ? 1 : 0, neighbor = points[index + offset];
  if (!point || !neighbor) return remap;
  const handle = { ...point[`${side}Handle`] }, segmentDuration = Math.abs(neighbor.time - point.time), direction = side === 'in' ? -1 : 1;
  const currentSpeed = Math.abs(handle.dt) > 1e-9 ? handle.dv / handle.dt : 0;
  if (Number.isFinite(Number(patch.influence))) handle.dt = direction * segmentDuration * clamp(Number(patch.influence), .2, 95) / 100;
  if (Number.isFinite(Number(patch.dt))) handle.dt = direction * clamp(Math.abs(Number(patch.dt)), segmentDuration * .002, segmentDuration * .95);
  const speed = Number.isFinite(Number(patch.speed)) ? clamp(Number(patch.speed), -MAX_TIME_REMAP_SPEED, MAX_TIME_REMAP_SPEED) : currentSpeed;
  handle.dv = Number.isFinite(Number(patch.dv)) ? Number(patch.dv) : speed * handle.dt;
  handle.dv = clamp(point.value + handle.dv, 0, mediaSpan(item)) - point.value;
  point[`${side}Handle`] = handle;
  point[`${side}Interpolation`] = 'bezier'; point.autoBezier = false;
  if (patch.split === true) point.continuous = false;
  if (point.continuous && patch.split !== true) {
    const otherSide = side === 'in' ? 'out' : 'in', other = point[`${otherSide}Handle`];
    if (other && Math.abs(other.dt) > 1e-9) other.dv = clamp(point.value + speed * other.dt, 0, mediaSpan(item)) - point.value;
    point[`${otherSide}Interpolation`] = 'continuous';
    point[`${side}Interpolation`] = 'continuous';
  }
  return normalizeTimeRemap(item, { ...remap, enabled: true, keyframes: points });
}

export function setTimeRemapInterpolation(item, index, type, sides = 'both') {
  const remap = normalizeTimeRemap(item), points = remap.keyframes.map(point => ({ ...point, inHandle: { ...point.inHandle }, outHandle: { ...point.outHandle } })), point = points[index];
  if (!point) return remap;
  const value = interpolation(type);
  if (sides === 'both' || sides === 'in') point.inInterpolation = value;
  if (sides === 'both' || sides === 'out') point.outInterpolation = value;
  point.autoBezier = value === 'auto';
  point.continuous = value === 'continuous' || value === 'auto';
  return normalizeTimeRemap(item, { ...remap, enabled: true, keyframes: points });
}

export function applyTimeRemapEase(item, index, mode = 'both') {
  let remap = normalizeTimeRemap(item);
  if (mode === 'both' || mode === 'in') remap = updateTimeRemapHandle({ ...item, timeRemap: remap }, index, 'in', { speed: 0, influence: 33.333, split: mode !== 'both' });
  if (mode === 'both' || mode === 'out') remap = updateTimeRemapHandle({ ...item, timeRemap: remap }, index, 'out', { speed: 0, influence: 33.333, split: mode !== 'both' });
  return remap;
}

export function removeTimeRemapKeyframe(item, index) {
  const remap = normalizeTimeRemap(item);
  if (index <= 0 || index >= remap.keyframes.length - 1) return remap;
  return normalizeTimeRemap(item, { ...remap, keyframes: remap.keyframes.filter((_, cursor) => cursor !== index) });
}

export function cropTimeRemappedItem(item, localStart, localEnd) {
  const duration = Math.max(1e-8, finite(item?.duration)), start = clamp(finite(localStart), 0, duration), end = clamp(finite(localEnd, duration), start, duration);
  const nextDuration = Math.max(1e-8, end - start), sourceIn = Math.max(0, finite(item?.sourceIn));
  let working = { ...item, timeRemap: addTimeRemapKeyframe(item, start) };
  working.timeRemap = addTimeRemapKeyframe(working, end);
  const selected = working.timeRemap.keyframes.filter(point => point.time >= start - 1e-7 && point.time <= end + 1e-7);
  const values = selected.flatMap((point, index) => [
    point.value,
    ...(index > 0 ? [point.value + point.inHandle.dv] : []),
    ...(index < selected.length - 1 ? [point.value + point.outHandle.dv] : []),
  ]);
  const minValue = clamp(Math.min(...values), 0, mediaSpan(item)), maxValue = clamp(Math.max(...values), minValue, mediaSpan(item));
  const next = { ...item, duration: nextDuration, sourceIn: sourceIn + minValue, sourceOut: sourceIn + maxValue };
  next.timeRemap = normalizeTimeRemap(next, {
    ...working.timeRemap,
    keyframes: selected.map(point => ({ ...point, time: point.time - start, value: point.value - minValue })),
  });
  return next;
}

export function timeRemapSamples(item, count = 64) {
  const total = Math.max(2, Math.round(finite(count, 64))), duration = Math.max(0, finite(item?.duration));
  return Array.from({ length: total }, (_, index) => {
    const time = duration * index / (total - 1), value = timeRemapValueAt(item, time);
    return { time, value, source: Math.max(0, finite(item?.sourceIn)) + clamp(value, 0, mediaSpan(item)), speed: timeRemapSpeedAt(item, time) };
  });
}

export function timeRemapFingerprint(item) {
  const remap = normalizeTimeRemap(item);
  return JSON.stringify({ duration: finite(item?.duration), sourceIn: finite(item?.sourceIn), sourceOut: finite(item?.sourceOut), ...remap });
}
