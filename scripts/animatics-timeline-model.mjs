const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function timelineEnd(item) {
  return finite(item?.start) + Math.max(0, finite(item?.duration));
}

export function normalizeRect(rect) {
  const x1 = Math.min(finite(rect?.x1), finite(rect?.x2));
  const x2 = Math.max(finite(rect?.x1), finite(rect?.x2));
  const y1 = Math.min(finite(rect?.y1), finite(rect?.y2));
  const y2 = Math.max(finite(rect?.y1), finite(rect?.y2));
  return { x1, x2, y1, y2 };
}

export function marqueeSelection(rect, entries, baseIds = [], mode = 'replace') {
  const box = normalizeRect(rect);
  const hits = new Set((entries || []).filter(entry => {
    const r = entry?.rect;
    return r && r.right >= box.x1 && r.left <= box.x2 && r.bottom >= box.y1 && r.top <= box.y2;
  }).map(entry => entry.id));
  if (mode === 'add') return new Set([...baseIds, ...hits]);
  if (mode === 'toggle') {
    const next = new Set(baseIds);
    for (const id of hits) next.has(id) ? next.delete(id) : next.add(id);
    return next;
  }
  return hits;
}

export function snappedMoveDelta({ moving = [], stationary = [], proposedDelta = 0, threshold = 0, extraTimes = [] } = {}) {
  const candidates = [...extraTimes.filter(Number.isFinite)];
  for (const clip of stationary) {
    candidates.push(finite(clip.start), timelineEnd(clip));
  }
  let best = null;
  for (const clip of moving) {
    const proposedStart = finite(clip.start) + proposedDelta;
    const movingEdges = [proposedStart, proposedStart + Math.max(0, finite(clip.duration))];
    for (const edge of movingEdges) {
      for (const candidate of candidates) {
        const adjustment = candidate - edge;
        if (Math.abs(adjustment) > threshold) continue;
        if (!best || Math.abs(adjustment) < Math.abs(best.adjustment)) {
          best = { adjustment, guide: candidate };
        }
      }
    }
  }
  return best
    ? { delta: proposedDelta + best.adjustment, guide: best.guide, snapped: true }
    : { delta: proposedDelta, guide: null, snapped: false };
}

function segmentFrom(item, localStart, localEnd, id, suffix = '') {
  const result = {
    ...item,
    id,
    start: finite(item.start) + localStart,
    duration: localEnd - localStart,
  };
  if (Number.isFinite(Number(item.sourceIn))) {
    result.sourceIn = finite(item.sourceIn) + localStart;
    result.sourceOut = result.sourceIn + result.duration;
  }
  if (suffix && typeof item.name === 'string') result.name = `${item.name} ${suffix}`;
  return result;
}

export function splitTimelineItem(item, time, { minDuration = 1 / 60, makeId = () => crypto.randomUUID() } = {}) {
  const start = finite(item?.start);
  const end = timelineEnd(item);
  const at = finite(time);
  if (!item || at <= start + minDuration || at >= end - minDuration) return null;
  const local = at - start;
  const left = segmentFrom(item, 0, local, item.id, 'A');
  const right = segmentFrom(item, local, end - start, makeId(), 'B');
  return [left, right];
}

function subtractIntervals(duration, intervals, minDuration) {
  let segments = [[0, duration]];
  for (const interval of intervals) {
    const next = [];
    for (const [a, b] of segments) {
      if (interval.end <= a || interval.start >= b) {
        next.push([a, b]);
        continue;
      }
      if (interval.start - a >= minDuration) next.push([a, Math.min(b, interval.start)]);
      if (b - interval.end >= minDuration) next.push([Math.max(a, interval.end), b]);
    }
    segments = next;
  }
  return segments;
}

export function resolveOverwrite(collection, movedIds, {
  minDuration = 1 / 60,
  makeId = () => crypto.randomUUID(),
} = {}) {
  const moved = new Set(movedIds || []);
  const inserted = (collection || []).filter(item => moved.has(item.id));
  const output = [...inserted];
  for (const item of (collection || []).filter(candidate => !moved.has(candidate.id))) {
    const itemStart = finite(item.start);
    const intervals = inserted
      .filter(candidate => finite(candidate.track) === finite(item.track))
      .map(candidate => ({
        start: Math.max(0, finite(candidate.start) - itemStart),
        end: Math.min(finite(item.duration), timelineEnd(candidate) - itemStart),
      }))
      .filter(interval => interval.end > interval.start)
      .sort((a, b) => a.start - b.start);
    if (!intervals.length) {
      output.push(item);
      continue;
    }
    const segments = subtractIntervals(finite(item.duration), intervals, minDuration);
    segments.forEach(([a, b], index) => {
      output.push(segmentFrom(item, a, b, index === 0 ? item.id : makeId(), segments.length > 1 ? String.fromCharCode(65 + index) : ''));
    });
  }
  return output.sort((a, b) => finite(a.track) - finite(b.track) || finite(a.start) - finite(b.start));
}

export function waveformPeaks(channels, bucketCount = 2048) {
  const source = (channels || []).filter(channel => channel && Number.isFinite(channel.length));
  if (!source.length || bucketCount <= 0) return [];
  const length = Math.max(...source.map(channel => channel.length));
  const buckets = Math.max(1, Math.min(Math.round(bucketCount), length || 1));
  const step = Math.max(1, Math.ceil(length / buckets));
  const peaks = new Array(buckets).fill(0);
  for (let bucket = 0; bucket < buckets; bucket++) {
    const start = bucket * step;
    const end = Math.min(length, start + step);
    let peak = 0;
    const sampleStep = Math.max(1, Math.floor((end - start) / 96));
    for (const channel of source) {
      for (let i = start; i < end && i < channel.length; i += sampleStep) peak = Math.max(peak, Math.abs(channel[i] || 0));
    }
    peaks[bucket] = Math.min(1, peak);
  }
  return peaks;
}

export function waveformWindow(peaks, sourceIn, sourceOut, duration) {
  if (!Array.isArray(peaks) || !peaks.length || !(duration > 0)) return [];
  const start = Math.max(0, Math.min(peaks.length - 1, Math.floor((Math.max(0, sourceIn) / duration) * peaks.length)));
  const end = Math.max(start + 1, Math.min(peaks.length, Math.ceil((Math.max(sourceIn, sourceOut) / duration) * peaks.length)));
  return peaks.slice(start, end);
}

export function createTimelineHistory({
  limit = 100,
  clone = value => structuredClone(value),
  fingerprint = value => JSON.stringify(value),
} = {}) {
  const maxEntries = Math.max(1, Math.round(Number(limit) || 100));
  let current = null;
  let currentFingerprint = null;
  let undoStack = [];
  let redoStack = [];

  const copy = value => value == null ? null : clone(value);
  const keyFor = value => value == null ? null : fingerprint(value);

  return {
    reset(value) {
      current = copy(value);
      currentFingerprint = keyFor(current);
      undoStack = [];
      redoStack = [];
    },
    commit(value) {
      const next = copy(value);
      const nextFingerprint = keyFor(next);
      if (current !== null && nextFingerprint === currentFingerprint) return false;
      if (current !== null) {
        undoStack.push(current);
        if (undoStack.length > maxEntries) undoStack.splice(0, undoStack.length - maxEntries);
      }
      current = next;
      currentFingerprint = nextFingerprint;
      redoStack = [];
      return true;
    },
    undo() {
      if (!undoStack.length) return null;
      if (current !== null) redoStack.push(current);
      current = undoStack.pop();
      currentFingerprint = keyFor(current);
      return copy(current);
    },
    redo() {
      if (!redoStack.length) return null;
      if (current !== null) undoStack.push(current);
      current = redoStack.pop();
      currentFingerprint = keyFor(current);
      return copy(current);
    },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    states: () => [current, ...undoStack, ...redoStack].filter(Boolean),
    sizes: () => ({ undo: undoStack.length, redo: redoStack.length }),
  };
}
