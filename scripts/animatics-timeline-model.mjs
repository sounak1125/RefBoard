const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function timelineEnd(item) {
  return finite(item?.start) + Math.max(0, finite(item?.duration));
}

/** Horizontal time window for timeline clip virtualization (lane px → seconds). */
export function timelineVisibleTimeRange({
  scrollLeft = 0,
  clientWidth = 0,
  pixelsPerSecond = 90,
  trackLabelWidth = 216,
  bufferViewports = 1.5,
} = {}) {
  const px = Math.max(.001, finite(pixelsPerSecond, 90));
  const label = Math.max(0, finite(trackLabelWidth));
  const viewportPx = Math.max(0, finite(clientWidth) - label);
  const bufferPx = Math.max(0, viewportPx * Math.max(0, finite(bufferViewports, 1.5)));
  const left = Math.max(0, finite(scrollLeft) - bufferPx);
  const right = finite(scrollLeft) + viewportPx + bufferPx;
  return { start: left / px, end: Math.max(left, right) / px, viewportPx, bufferPx };
}

export function clipIntersectsTimeRange(clip, rangeStart, rangeEnd) {
  const start = finite(clip?.start);
  const end = start + Math.max(0, finite(clip?.duration));
  return end > finite(rangeStart) && start < finite(rangeEnd);
}

export function filterClipsInTimeRange(clips, rangeStart, rangeEnd) {
  return (clips || []).filter(clip => clipIntersectsTimeRange(clip, rangeStart, rangeEnd));
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

export function constrainedTrackDelta(items = [], requestedDelta = 0, trackCount = 1) {
  const tracks=(items||[]).map(item=>Math.max(0,Math.round(finite(item?.track))));
  if(!tracks.length)return 0;
  const maximumTrack=Math.max(0,Math.round(finite(trackCount,1))-1),minimum=Math.min(...tracks),maximum=Math.max(...tracks),requested=Math.round(finite(requestedDelta));
  const delta=Math.max(-minimum,Math.min(maximumTrack-maximum,requested));
  return delta===0?0:delta;
}

export function snappedMoveDelta({ moving = [], stationary = [], proposedDelta = 0, threshold = 0, extraTimes = [] } = {}) {
  const globalCandidates = [...extraTimes.filter(Number.isFinite)];
  let best = null;
  for (const clip of moving) {
    const candidates=[...globalCandidates];
    for(const candidate of stationary){
      candidates.push(finite(candidate.start),timelineEnd(candidate));
    }
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

export function timelineTrackGaps(collection, track, { minDuration = 1 / 60 } = {}) {
  const clips = (collection || [])
    .filter(item => finite(item?.track) === finite(track) && finite(item?.duration) > 0)
    .sort((a, b) => finite(a.start) - finite(b.start) || timelineEnd(a) - timelineEnd(b));
  if (clips.length < 2) return [];
  const gaps = [];
  let occupiedEnd = timelineEnd(clips[0]);
  let leftId = clips[0].id;
  for (const clip of clips.slice(1)) {
    const start = finite(clip.start);
    if (start - occupiedEnd >= minDuration) {
      gaps.push({ track: finite(track), start: occupiedEnd, end: start, duration: start - occupiedEnd, leftId, rightId: clip.id });
    }
    if (timelineEnd(clip) > occupiedEnd) {
      occupiedEnd = timelineEnd(clip);
      leftId = clip.id;
    }
  }
  return gaps;
}

export function closeTimelineTrackGap(collection, gap) {
  const track = finite(gap?.track);
  const start = finite(gap?.start);
  const end = finite(gap?.end);
  const duration = Math.max(0, end - start);
  if (!duration) return [...(collection || [])];
  return (collection || []).map(item => (
    finite(item?.track) === track && finite(item?.start) >= end - 1e-8
      ? { ...item, start: Math.max(0, finite(item.start) - duration) }
      : item
  )).sort((a, b) => finite(a.track) - finite(b.track) || finite(a.start) - finite(b.start));
}

export function reorderTimelineTracks(collection, fromTrack, toTrack) {
  const from = Math.max(0, Math.round(finite(fromTrack)));
  const to = Math.max(0, Math.round(finite(toTrack)));
  if (from === to) return [...(collection || [])];
  return (collection || []).map(item => {
    const track = Math.max(0, Math.round(finite(item?.track)));
    let nextTrack = track;
    if (track === from) nextTrack = to;
    else if (from < to && track > from && track <= to) nextTrack = track - 1;
    else if (from > to && track >= to && track < from) nextTrack = track + 1;
    return nextTrack === track ? item : { ...item, track: nextTrack };
  });
}

export function linkedTimelineIds(items, ids) {
  const selected = new Set(ids || []);
  const groups = new Set((items || []).filter(item => selected.has(item.id) && item.linkGroupId).map(item => item.linkGroupId));
  if (!groups.size) return selected;
  for (const item of items || []) if (groups.has(item.linkGroupId)) selected.add(item.id);
  return selected;
}

function cloneClipboardItem(item) {
  const copy = { ...item };
  if (item?.framing) copy.framing = { ...item.framing };
  if (Array.isArray(item?.strokes)) copy.strokes = structuredClone(item.strokes);
  return copy;
}

export function createTimelineClipboard(entries, ids, { includeLinked = true } = {}) {
  const source = (entries || []).filter(entry => entry?.item?.id && ['video', 'text', 'audio'].includes(entry.kind));
  const requested = new Set(ids || []);
  const selected = includeLinked ? linkedTimelineIds(source.map(entry => entry.item), requested) : requested;
  const copied = source.filter(entry => selected.has(entry.item.id)).map(entry => ({ kind: entry.kind, item: cloneClipboardItem(entry.item) }));
  if (!copied.length) return null;
  const videoTracks = copied.filter(entry => entry.kind === 'video').map(entry => Math.max(0, Math.round(finite(entry.item.track))));
  const audioTracks = copied.filter(entry => entry.kind === 'audio').map(entry => Math.max(0, Math.round(finite(entry.item.track))));
  return {
    version: 1,
    entries: copied,
    originStart: Math.min(...copied.map(entry => finite(entry.item.start))),
    videoTrackOrigin: videoTracks.length ? Math.min(...videoTracks) : 0,
    audioTrackOrigin: audioTracks.length ? Math.min(...audioTracks) : 0,
  };
}

export function pasteTimelineClipboard(clipboard, {
  start = 0,
  videoTrack = 0,
  audioTrack = 0,
  videoTrackCount = 1,
  audioTrackCount = 0,
  maxVideoTracks = 8,
  maxAudioTracks = 5,
  sequenceEnd = null,
  makeId = () => crypto.randomUUID(),
  makeLinkId = () => crypto.randomUUID(),
} = {}) {
  const source = (clipboard?.entries || []).filter(entry => entry?.item?.id && ['video', 'text', 'audio'].includes(entry.kind));
  if (!source.length) return { ok: false, reason: 'empty', entries: [], ids: [] };
  const targetStart = Math.max(0, finite(start));
  const originStart = finite(clipboard.originStart, Math.min(...source.map(entry => finite(entry.item.start))));
  const targetVideoTrack = Math.max(0, Math.round(finite(videoTrack)));
  const targetAudioTrack = Math.max(0, Math.round(finite(audioTrack)));
  const sourceVideoTrack = Math.max(0, Math.round(finite(clipboard.videoTrackOrigin)));
  const sourceAudioTrack = Math.max(0, Math.round(finite(clipboard.audioTrackOrigin)));
  const linkIds = new Map();
  const entries = source.map(entry => {
    const item = cloneClipboardItem(entry.item);
    item.id = makeId();
    item.start = targetStart + Math.max(0, finite(entry.item.start) - originStart);
    if (entry.kind === 'video') item.track = targetVideoTrack + Math.max(0, Math.round(finite(entry.item.track)) - sourceVideoTrack);
    else if (entry.kind === 'audio') item.track = targetAudioTrack + Math.max(0, Math.round(finite(entry.item.track)) - sourceAudioTrack);
    else item.track = 0;
    if (entry.item.linkGroupId) {
      if (!linkIds.has(entry.item.linkGroupId)) linkIds.set(entry.item.linkGroupId, makeLinkId());
      item.linkGroupId = linkIds.get(entry.item.linkGroupId);
    }
    return { kind: entry.kind, item };
  });
  const requiredVideoTracks = Math.max(
    1,
    Math.round(finite(videoTrackCount, 1)),
    1 + Math.max(-1, ...entries.filter(entry => entry.kind === 'video').map(entry => entry.item.track)),
  );
  const requiredAudioTracks = Math.max(
    0,
    Math.round(finite(audioTrackCount)),
    1 + Math.max(-1, ...entries.filter(entry => entry.kind === 'audio').map(entry => entry.item.track)),
  );
  if (requiredVideoTracks > maxVideoTracks || requiredAudioTracks > maxAudioTracks) {
    return { ok: false, reason: 'track-limit', entries: [], ids: [], requiredVideoTracks, requiredAudioTracks };
  }
  if (Number.isFinite(sequenceEnd) && entries.some(entry => timelineEnd(entry.item) > sequenceEnd + 1e-8)) {
    return { ok: false, reason: 'sequence-end', entries: [], ids: [], requiredVideoTracks, requiredAudioTracks };
  }
  const normalized = normalizeTimelineLinks(entries.map(entry => entry.item));
  const normalizedById = new Map(normalized.map(item => [item.id, item]));
  const output = entries.map(entry => ({ kind: entry.kind, item: normalizedById.get(entry.item.id) }));
  return {
    ok: true,
    entries: output,
    ids: output.map(entry => entry.item.id),
    requiredVideoTracks,
    requiredAudioTracks,
  };
}

export function normalizeTimelineLinks(items) {
  const counts = new Map();
  for (const item of items || []) if (item.linkGroupId) counts.set(item.linkGroupId, (counts.get(item.linkGroupId) || 0) + 1);
  return (items || []).map(item => {
    if (!item.linkGroupId || counts.get(item.linkGroupId) >= 2) return item;
    const next = { ...item };
    delete next.linkGroupId;
    return next;
  });
}

export function linkTimelineItems(items, ids, linkGroupId) {
  const selected = new Set(ids || []);
  const linked = (items || []).map(item => selected.has(item.id) ? { ...item, linkGroupId } : item);
  return normalizeTimelineLinks(linked);
}

export function unlinkTimelineItems(items, ids) {
  const selected = new Set(ids || []);
  const unlinked = (items || []).map(item => {
    if (!selected.has(item.id) || !item.linkGroupId) return item;
    const next = { ...item };
    delete next.linkGroupId;
    return next;
  });
  return normalizeTimelineLinks(unlinked);
}

export function applyBatchTimelineDuration(items, ids, requestedDuration, {
  minDuration = 1 / 60,
  sequenceEnd = null,
  maxDuration = () => Infinity,
} = {}) {
  const selected = new Set(ids || []);
  const changedIds = [];
  const clampedIds = [];
  const wanted = Math.max(minDuration, finite(requestedDuration, minDuration));
  const output = (items || []).map(item => {
    if (!selected.has(item.id)) return item;
    const sourceMax = Math.max(minDuration, finite(maxDuration(item), Infinity));
    const sequenceMax = Number.isFinite(sequenceEnd) ? Math.max(minDuration, sequenceEnd - finite(item.start)) : Infinity;
    const duration = Math.max(minDuration, Math.min(wanted, sourceMax, sequenceMax));
    if (Math.abs(duration - wanted) > 1e-8) clampedIds.push(item.id);
    if (Math.abs(duration - finite(item.duration)) <= 1e-8) return item;
    const next = { ...item, duration };
    if (Number.isFinite(Number(item.sourceIn)) && Number.isFinite(Number(item.originalDuration))) next.sourceOut = finite(item.sourceIn) + duration;
    changedIds.push(item.id);
    return next;
  });
  return { items: output, changedIds, clampedIds };
}

export function splitLinkedTimelineItems(items, targetId, time, {
  minDuration = 1 / 60,
  makeId = () => crypto.randomUUID(),
  makeLinkId = () => crypto.randomUUID(),
} = {}) {
  const source = items || [];
  const target = source.find(item => item.id === targetId);
  if (!target) return null;
  const targetPieces = splitTimelineItem(target, time, { minDuration, makeId });
  if (!targetPieces) return null;
  const groupId = target.linkGroupId || null;
  const members = groupId ? source.filter(item => item.linkGroupId === groupId) : [target];
  const memberIds = new Set(members.map(item => item.id));
  const left = [];
  const right = [];
  const replacements = new Map();
  const rightIds = [];
  const splitIds = [];

  for (const member of members) {
    const pieces = member.id === target.id
      ? targetPieces
      : splitTimelineItem(member, time, { minDuration, makeId });
    if (pieces) {
      if (Array.isArray(pieces[1].strokes)) pieces[1].strokes = structuredClone(pieces[1].strokes);
      left.push(pieces[0]);
      right.push(pieces[1]);
      replacements.set(member.id, pieces);
      rightIds.push(pieces[1].id);
      splitIds.push(member.id);
    } else if (timelineEnd(member) <= finite(time) || (finite(member.start) < finite(time) && finite(member.start) + finite(member.duration) / 2 <= finite(time))) {
      left.push({ ...member });
      replacements.set(member.id, [left.at(-1)]);
    } else {
      right.push({ ...member });
      replacements.set(member.id, [right.at(-1)]);
    }
  }

  if (groupId) {
    const leftGroupId = left.length >= 2 ? makeLinkId() : null;
    const rightGroupId = right.length >= 2 ? makeLinkId() : null;
    for (const item of left) leftGroupId ? item.linkGroupId = leftGroupId : delete item.linkGroupId;
    for (const item of right) rightGroupId ? item.linkGroupId = rightGroupId : delete item.linkGroupId;
  }

  const output = [];
  for (const item of source) {
    if (!memberIds.has(item.id)) output.push(item);
    else output.push(...replacements.get(item.id));
  }
  return { items: normalizeTimelineLinks(output), rightIds, splitIds, targetRightId: targetPieces[1].id };
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
      const segment=segmentFrom(item, a, b, index === 0 ? item.id : makeId(), segments.length > 1 ? String.fromCharCode(65 + index) : '');
      if(segments.length>1)delete segment.linkGroupId;
      output.push(segment);
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
