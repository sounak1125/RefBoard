import assert from 'node:assert/strict';
import {
  MAX_AUDIO_GAIN,
  audioEnvelopeDbPoints,
  audioEnvelopePoints,
  audioFadeCurveValue,
  audioFadeGainAt,
  audioWaveformDisplayPeak,
  dbToGain,
  gainToDb,
  normalizedAudioFades,
} from './animatics-audio-model.mjs';

assert.ok(Math.abs(dbToGain(-6) - .501187) < 1e-6);
assert.ok(Math.abs(gainToDb(.5) + 6.0206) < 1e-4);
assert.ok(Math.abs(dbToGain(12) - MAX_AUDIO_GAIN) < 1e-6);
assert.equal(dbToGain(-96), 0);

const normalized = normalizedAudioFades({ duration:4, fadeInDuration:3, fadeOutDuration:3, fadeInCurve:'bad', fadeOutCurve:'custom', fadeOutShape:250 });
assert.equal(normalized.fadeInDuration, 2);
assert.equal(normalized.fadeOutDuration, 2);
assert.equal(normalized.fadeInCurve, 'constant-power');
assert.equal(normalized.fadeOutCurve, 'custom');
assert.equal(normalized.fadeOutShape, 100);

assert.equal(audioFadeCurveValue('constant-gain', .5), .5);
assert.ok(Math.abs(audioFadeCurveValue('constant-power', .5) - Math.SQRT1_2) < 1e-9);
assert.ok(audioFadeCurveValue('exponential', .5) < .2);
assert.ok(audioFadeCurveValue('custom', .5, 100) > audioFadeCurveValue('custom', .5, -100));

const clip = { duration:6, volume:.5, fadeInDuration:2, fadeOutDuration:2, fadeInCurve:'constant-gain', fadeOutCurve:'constant-power' };
assert.equal(audioFadeGainAt(clip, 0), 0);
assert.equal(audioFadeGainAt(clip, 1), .5);
assert.equal(audioFadeGainAt(clip, 3), 1);
assert.ok(Math.abs(audioFadeGainAt(clip, 5) - Math.SQRT1_2) < 1e-9);
assert.equal(audioFadeGainAt(clip, 6), 0);
assert.equal(audioWaveformDisplayPeak({ duration:4, volume:1 }, .8, 2), .8);
assert.ok(Math.abs(audioWaveformDisplayPeak({ duration:4, volume:dbToGain(-6) }, .8, 2) - .40095) < 1e-4, '-6 dB must render a half-height waveform');
assert.ok(Math.abs(audioWaveformDisplayPeak({ duration:4, volume:dbToGain(-12) }, .8, 2) - .20095) < 1e-4, '-12 dB must render a quarter-height waveform');
assert.equal(audioWaveformDisplayPeak({ duration:4, volume:0 }, .8, 2), 0, 'muted clip gain must flatten the waveform');
assert.equal(audioWaveformDisplayPeak({ duration:4, volume:2 }, .8, 2), 1, 'amplified waveform peaks must stay inside the track');
assert.equal(audioWaveformDisplayPeak({ duration:4, volume:1, fadeInDuration:2, fadeInCurve:'constant-gain' }, .8, 1), .4, 'fade automation must shape the displayed waveform');

const range = audioEnvelopePoints(clip, { start:1, end:5, samplesPerFade:8 });
assert.equal(range[0].time, 1);
assert.equal(range.at(-1).time, 5);
assert.ok(range.some(point => point.time === 2 && point.gain === 1), 'fade boundary must be exported exactly');
assert.ok(range.some(point => point.time === 4 && point.gain === 1), 'fade-out boundary must be exported exactly');

const db = audioEnvelopeDbPoints(clip, { start:0, end:6, samplesPerFade:8 });
assert.equal(db[0].db, -96);
assert.ok(Math.abs(db.find(point => point.time === 2).db + 6.0206) < 1e-4);
assert.equal(db.at(-1).db, -96);

console.log('animatics audio model tests passed');
