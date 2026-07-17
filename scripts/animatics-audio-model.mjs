const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export const AUDIO_FADE_CURVES = ['constant-gain', 'constant-power', 'exponential', 'custom'];
export const MIN_AUDIO_DB = -96;
export const MAX_AUDIO_DB = 12;
export const MAX_AUDIO_GAIN = 3.981072;

export function dbToGain(db) {
  const level = clamp(finite(db, 0), MIN_AUDIO_DB, MAX_AUDIO_DB);
  return level <= MIN_AUDIO_DB ? 0 : Math.pow(10, level / 20);
}

export function gainToDb(gain) {
  const level = Math.max(0, finite(gain, 1));
  return level <= 1e-8 ? MIN_AUDIO_DB : clamp(20 * Math.log10(level), MIN_AUDIO_DB, MAX_AUDIO_DB);
}

export function normalizeAudioFadeCurve(value) {
  return AUDIO_FADE_CURVES.includes(value) ? value : 'constant-power';
}

export function normalizedAudioFades(item = {}) {
  const duration = Math.max(0, finite(item.duration));
  let fadeInDuration = clamp(finite(item.fadeInDuration), 0, duration);
  let fadeOutDuration = clamp(finite(item.fadeOutDuration), 0, duration);
  if (fadeInDuration + fadeOutDuration > duration && duration > 0) {
    const scale = duration / (fadeInDuration + fadeOutDuration);
    fadeInDuration *= scale;
    fadeOutDuration *= scale;
  }
  return {
    fadeInDuration,
    fadeOutDuration,
    fadeInCurve: normalizeAudioFadeCurve(item.fadeInCurve),
    fadeOutCurve: normalizeAudioFadeCurve(item.fadeOutCurve),
    fadeInShape: clamp(finite(item.fadeInShape), -100, 100),
    fadeOutShape: clamp(finite(item.fadeOutShape), -100, 100),
  };
}

export function audioFadeCurveValue(curve, progress, customShape = 0) {
  const t = clamp(finite(progress), 0, 1);
  switch (normalizeAudioFadeCurve(curve)) {
    case 'constant-gain': return t;
    case 'exponential': {
      const amount = 5;
      return (Math.exp(amount * t) - 1) / (Math.exp(amount) - 1);
    }
    case 'custom': {
      const exponent = Math.pow(2, -clamp(finite(customShape), -100, 100) / 50);
      return Math.pow(t, exponent);
    }
    default: return Math.sin(t * Math.PI / 2);
  }
}

export function audioFadeGainAt(item, localTime) {
  const duration = Math.max(0, finite(item?.duration));
  const time = clamp(finite(localTime), 0, duration);
  const fades = normalizedAudioFades(item);
  let gain = 1;
  if (fades.fadeInDuration > 1e-9 && time < fades.fadeInDuration) {
    gain *= audioFadeCurveValue(fades.fadeInCurve, time / fades.fadeInDuration, fades.fadeInShape);
  }
  if (fades.fadeOutDuration > 1e-9 && time > duration - fades.fadeOutDuration) {
    gain *= audioFadeCurveValue(fades.fadeOutCurve, (duration - time) / fades.fadeOutDuration, fades.fadeOutShape);
  }
  return clamp(gain, 0, 1);
}

export function audioWaveformDisplayPeak(item, peak, localTime) {
  const sourcePeak = clamp(finite(peak), 0, 1);
  const clipGain = clamp(finite(item?.volume, 1), 0, MAX_AUDIO_GAIN);
  return clamp(sourcePeak * clipGain * audioFadeGainAt(item, localTime), 0, 1);
}

export function audioEnvelopePoints(item, { start = 0, end = item?.duration, samplesPerFade = 24 } = {}) {
  const duration = Math.max(0, finite(item?.duration));
  const rangeStart = clamp(finite(start), 0, duration);
  const rangeEnd = clamp(finite(end, duration), rangeStart, duration);
  const fades = normalizedAudioFades(item);
  const times = new Set([rangeStart, rangeEnd]);
  const samples = Math.max(2, Math.round(finite(samplesPerFade, 24)));
  const addRange = (from, to) => {
    const first = Math.max(rangeStart, from), last = Math.min(rangeEnd, to);
    if (last < first) return;
    times.add(first);times.add(last);
    for (let index = 1; index < samples; index++) {
      const time = from + (to - from) * index / samples;
      if (time > rangeStart && time < rangeEnd) times.add(time);
    }
  };
  if (fades.fadeInDuration > 0) addRange(0, fades.fadeInDuration);
  if (fades.fadeOutDuration > 0) addRange(duration - fades.fadeOutDuration, duration);
  return [...times].sort((a, b) => a - b).map(time => ({
    time,
    gain: audioFadeGainAt(item, time),
  }));
}

export function audioEnvelopeDbPoints(item, options = {}) {
  const baseGain = Math.max(0, finite(options.baseGain, item?.volume ?? 1));
  return audioEnvelopePoints(item, options).map(point => ({
    time: point.time,
    gain: point.gain * baseGain,
    db: gainToDb(point.gain * baseGain),
  }));
}
