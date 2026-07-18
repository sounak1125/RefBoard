import assert from 'node:assert/strict';
import {
  applyBatchTimelineDuration,
  closeTimelineTrackGap,
  constrainedTrackDelta,
  createTimelineClipboard,
  createTimelineHistory,
  linkedTimelineIds,
  linkTimelineItems,
  marqueeSelection,
  normalizeTimelineLinks,
  pasteTimelineClipboard,
  reorderTimelineTracks,
  resolveOverwrite,
  snappedMoveDelta,
  splitLinkedTimelineItems,
  splitTimelineItem,
  timelineTrackGaps,
  unlinkTimelineItems,
  waveformPeaks,
  waveformWindow,
} from './animatics-timeline-model.mjs';

const ids = set => [...set].sort();

assert.deepEqual(ids(marqueeSelection({ x1: 0, y1: 0, x2: 80, y2: 30 }, [
  { id: 'a', rect: { left: 10, top: 4, right: 40, bottom: 20 } },
  { id: 'b', rect: { left: 100, top: 4, right: 140, bottom: 20 } },
])), ['a']);
assert.deepEqual(ids(marqueeSelection({ x1: 90, y1: 0, x2: 150, y2: 30 }, [
  { id: 'b', rect: { left: 100, top: 4, right: 140, bottom: 20 } },
], ['a'], 'add')), ['a', 'b']);
assert.deepEqual(ids(marqueeSelection({ x1: 0, y1: 0, x2: 150, y2: 30 }, [
  { id: 'a', rect: { left: 10, top: 4, right: 40, bottom: 20 } },
  { id: 'b', rect: { left: 100, top: 4, right: 140, bottom: 20 } },
], ['a'], 'toggle')), ['b']);

assert.deepEqual(snappedMoveDelta({
  moving: [{ start: 2, duration: 3 }], stationary: [{ start: 8, duration: 2 }], proposedDelta: 2.92, threshold: .1,
}), { delta: 3, guide: 8, snapped: true });
assert.equal(snappedMoveDelta({ moving: [{ start: 2, duration: 3 }], stationary: [], proposedDelta: 1, threshold: .1, extraTimes: [10] }).snapped, false);
assert.equal(constrainedTrackDelta([{ track:0 },{ track:1 }],-1,3),0,'a linked group at V1 must not collapse upward');
assert.equal(constrainedTrackDelta([{ track:0 },{ track:1 }],1,3),1,'a linked V1/V2 group may move intact to V2/V3');
assert.equal(constrainedTrackDelta([{ track:0 },{ track:1 }],1,2),0,'a linked group must stop when no complete destination span exists');
const linkedSnap=snappedMoveDelta({
  moving:[{ start:0,duration:2,track:0,kind:'video',targetTrack:0 },{ start:5,duration:2,track:1,kind:'video',targetTrack:1 }],
  stationary:[{ start:8,duration:2,track:1,kind:'video' },{ start:7.95,duration:2,track:1,kind:'audio' }],
  proposedDelta:.95,threshold:.1,
});
assert.equal(linkedSnap.snapped,true,'any linked video edge must snap against its own destination track');
assert.equal(linkedSnap.guide,7.95,'linked snapping must use the closest edge even when it belongs to audio');
assert.ok(Math.abs(linkedSnap.delta-.95)<1e-9,'the linked group must receive one shared cross-media snap delta');
const crossTrackVideoSnap=snappedMoveDelta({
  moving:[{start:0,duration:2,track:0,kind:'video'}],
  stationary:[{start:5,duration:2,track:1,kind:'video'}],
  proposedDelta:2.95,threshold:.1,
});
assert.deepEqual(crossTrackVideoSnap,{delta:3,guide:5,snapped:true},'video clips must snap to aligned edges on other video tracks');
const crossTrackAudioSnap=snappedMoveDelta({
  moving:[{start:0,duration:2,track:0,kind:'audio'}],
  stationary:[{start:5,duration:2,track:1,kind:'audio'}],
  proposedDelta:2.95,threshold:.1,
});
assert.deepEqual(crossTrackAudioSnap,{delta:3,guide:5,snapped:true},'audio clips must snap across audio tracks');
assert.deepEqual(snappedMoveDelta({moving:[{start:0,duration:2,kind:'video'}],stationary:[{start:5,duration:2,kind:'audio'}],proposedDelta:2.95,threshold:.1}),{delta:3,guide:5,snapped:true},'video clips must snap to audio edges');
assert.deepEqual(snappedMoveDelta({moving:[{start:0,duration:2,kind:'audio'}],stationary:[{start:5,duration:2,kind:'video'}],proposedDelta:2.95,threshold:.1}),{delta:3,guide:5,snapped:true},'audio clips must snap to video edges');

let nextId = 0;
const video = { id: 'v', track: 0, start: 2, duration: 6, sourceIn: 10, sourceOut: 16, name: 'Video' };
const split = splitTimelineItem(video, 5, { minDuration: .01, makeId: () => `n${++nextId}` });
assert.deepEqual(split.map(x => [x.start, x.duration, x.sourceIn, x.sourceOut]), [[2, 3, 10, 13], [5, 3, 13, 16]]);
assert.equal(splitTimelineItem(video, 2.001, { minDuration: .01 }), null);

const trackItems = [
  { id: 'v1', track: 0, start: 0, duration: 2 },
  { id: 'v2', track: 0, start: 4, duration: 2 },
  { id: 'v3', track: 1, start: 5, duration: 2 },
];
assert.deepEqual(timelineTrackGaps(trackItems, 0).map(gap => [gap.start, gap.end, gap.leftId, gap.rightId]), [[2, 4, 'v1', 'v2']]);
assert.deepEqual(closeTimelineTrackGap(trackItems, timelineTrackGaps(trackItems, 0)[0]).map(item => [item.id, item.start]), [['v1', 0], ['v2', 2], ['v3', 5]], 'gap ripple must affect only its exact track');
assert.deepEqual(reorderTimelineTracks([
  { id: 'top', track: 0 }, { id: 'middle', track: 1 }, { id: 'bottom', track: 2 },
], 0, 2).map(item => [item.id, item.track]), [['top', 2], ['middle', 0], ['bottom', 1]], 'moving a track must shift intervening tracks without losing their contents');
assert.deepEqual(timelineTrackGaps([
  { id: 'a', track: 0, start: 0, duration: 5 },
  { id: 'b', track: 0, start: 3, duration: 4 },
  { id: 'c', track: 0, start: 8, duration: 1 },
], 0).map(gap => [gap.start, gap.end]), [[7, 8]], 'overlaps must be merged before deriving gaps');

const durationResult = applyBatchTimelineDuration([
  { id: 'image', start: 0, duration: 3 },
  { id: 'audio', start: 4, duration: 3, sourceIn: 2, sourceOut: 5, originalDuration: 7 },
  { id: 'other', start: 0, duration: 9 },
], ['image', 'audio'], 6, { sequenceEnd: 10, maxDuration: item => item.originalDuration ? item.originalDuration - item.sourceIn : 600 });
assert.deepEqual(durationResult.items.map(item => [item.id, item.duration, item.sourceOut]), [['image', 6, undefined], ['audio', 5, 7], ['other', 9, undefined]]);
assert.deepEqual(durationResult.clampedIds, ['audio']);

let linked = linkTimelineItems([
  { id: 'picture', start: 0, duration: 5 },
  { id: 'sound', start: 0, duration: 7 },
  { id: 'free', start: 9, duration: 1 },
], ['picture', 'sound'], 'link-1');
assert.deepEqual(ids(linkedTimelineIds(linked, ['picture'])), ['picture', 'sound']);
linked = unlinkTimelineItems(linked, ['picture']);
assert.equal(linked.some(item => item.linkGroupId), false, 'unlinking must remove orphaned link metadata');
assert.equal(normalizeTimelineLinks([{ id: 'orphan', linkGroupId: 'x' }])[0].linkGroupId, undefined);

const clipboardSource = [
  { kind: 'video', item: { id: 'picture', track: 1, start: 2, duration: 3, linkGroupId: 'pair', framing: { fit: 'contain', scale: 1 }, strokes: [[{ x: .1, y: .2 }]] } },
  { kind: 'audio', item: { id: 'sound', track: 2, start: 2.5, duration: 5, linkGroupId: 'pair', sourceIn: 4, sourceOut: 9, originalDuration: 12 } },
  { kind: 'video', item: { id: 'other', track: 2, start: 6, duration: 1 } },
];
const linkedClipboard = createTimelineClipboard(clipboardSource, ['picture']);
assert.deepEqual(linkedClipboard.entries.map(entry => entry.item.id), ['picture', 'sound'], 'copying a linked visual must include its linked audio peer');
linkedClipboard.entries[0].item.framing.scale = 2;
linkedClipboard.entries[0].item.strokes[0][0].x = .9;
assert.equal(clipboardSource[0].item.framing.scale, 1, 'clipboard framing must not alias the live clip');
assert.equal(clipboardSource[0].item.strokes[0][0].x, .1, 'clipboard strokes must not alias the live clip');
linkedClipboard.entries[0].item.framing.scale = 1;
linkedClipboard.entries[0].item.strokes[0][0].x = .1;

let pastedId = 0;
let pastedLinkId = 0;
const linkedPaste = pasteTimelineClipboard(linkedClipboard, {
  start: 10,
  videoTrack: 1,
  audioTrack: 0,
  videoTrackCount: 2,
  audioTrackCount: 3,
  makeId: () => `paste-${++pastedId}`,
  makeLinkId: () => `paste-link-${++pastedLinkId}`,
});
assert.equal(linkedPaste.ok, true);
assert.deepEqual(linkedPaste.entries.map(entry => [entry.kind, entry.item.id, entry.item.track, entry.item.start]), [
  ['video', 'paste-1', 1, 10],
  ['audio', 'paste-2', 0, 10.5],
]);
assert.equal(linkedPaste.entries[0].item.linkGroupId, 'paste-link-1');
assert.equal(linkedPaste.entries[1].item.linkGroupId, 'paste-link-1', 'pasted peers must share a newly generated link group');

const multiTrackClipboard = createTimelineClipboard(clipboardSource, ['picture', 'other'], { includeLinked: false });
const multiTrackPaste = pasteTimelineClipboard(multiTrackClipboard, {
  start: 20,
  videoTrack: 2,
  videoTrackCount: 3,
  makeId: () => `multi-${++pastedId}`,
});
assert.deepEqual(multiTrackPaste.entries.map(entry => [entry.item.track, entry.item.start]), [[2, 20], [3, 24]], 'multi-track paste must preserve relative track and time offsets from the active target');
assert.equal(multiTrackPaste.requiredVideoTracks, 4);
assert.equal(pasteTimelineClipboard(multiTrackClipboard, { start: 20, videoTrack: 7, maxVideoTracks: 8 }).reason, 'track-limit');
assert.equal(pasteTimelineClipboard(linkedClipboard, { start: 10, sequenceEnd: 12 }).reason, 'sequence-end', 'fixed sequences must reject partial clipboard pastes');

let cutId = 0;
let cutLinkId = 0;
linked = linkTimelineItems([
  { id: 'picture', start: 0, duration: 5, sourceIn: 1, sourceOut: 6, originalDuration: 8 },
  { id: 'sound', start: 0, duration: 7, sourceIn: 2, sourceOut: 9, originalDuration: 10 },
], ['picture', 'sound'], 'link-1');
const linkedCut = splitLinkedTimelineItems(linked, 'picture', 3, {
  minDuration: .01,
  makeId: () => `piece-${++cutId}`,
  makeLinkId: () => `side-${++cutLinkId}`,
});
assert.deepEqual(linkedCut.items.map(item => [item.id, item.start, item.duration, item.sourceIn, item.sourceOut, item.linkGroupId]), [
  ['picture', 0, 3, 1, 4, 'side-1'],
  ['piece-1', 3, 2, 4, 6, 'side-2'],
  ['sound', 0, 3, 2, 5, 'side-1'],
  ['piece-2', 3, 4, 5, 9, 'side-2'],
]);
assert.deepEqual(linkedCut.rightIds, ['piece-1', 'piece-2']);
assert.equal(linkedCut.targetRightId, 'piece-1');

const overwriteBase = [
  { id: 'old', track: 0, start: 0, duration: 10, sourceIn: 4, sourceOut: 14, name: 'Old' },
  { id: 'move', track: 0, start: 3, duration: 2, sourceIn: 0, sourceOut: 2, name: 'Move' },
];
nextId = 0;
let overwritten = resolveOverwrite(overwriteBase, ['move'], { minDuration: .01, makeId: () => `cut${++nextId}` });
assert.deepEqual(overwritten.map(x => [x.id, x.start, x.duration, x.sourceIn, x.sourceOut]), [
  ['old', 0, 3, 4, 7], ['move', 3, 2, 0, 2], ['cut1', 5, 5, 9, 14],
]);
overwritten = resolveOverwrite([{ id: 'old', track: 0, start: 1, duration: 2 }, { id: 'move', track: 0, start: 0, duration: 5 }], ['move']);
assert.deepEqual(overwritten.map(x => x.id), ['move']);
overwritten = resolveOverwrite([{ id: 'old', track: 1, start: 1, duration: 2 }, { id: 'move', track: 0, start: 0, duration: 5 }], ['move']);
assert.deepEqual(overwritten.map(x => x.id).sort(), ['move', 'old']);
overwritten = resolveOverwrite([{ id: 'old', track: 0, start: 0, duration: 5, sourceIn: 10 }, { id: 'move', track: 0, start: 3, duration: 4 }], ['move']);
assert.deepEqual(overwritten.map(x => [x.id, x.start, x.duration, x.sourceIn]), [['old', 0, 3, 10], ['move', 3, 4, undefined]]);
overwritten = resolveOverwrite([{ id: 'move', track: 0, start: 0, duration: 3 }, { id: 'old', track: 0, start: 2, duration: 5, sourceIn: 4 }], ['move']);
assert.deepEqual(overwritten.map(x => [x.id, x.start, x.duration, x.sourceIn]), [['move', 0, 3, undefined], ['old', 3, 4, 5]]);
overwritten = resolveOverwrite([{ id: 'a', track: 0, start: 0, duration: 4 }, { id: 'b', track: 0, start: 2, duration: 4 }], ['a', 'b']);
assert.deepEqual(overwritten.map(x => x.id), ['a', 'b'], 'selected clips must not cut one another');
overwritten = resolveOverwrite([{ id: 'linked', linkGroupId: 'pair', track: 0, start: 0, duration: 8 }, { id: 'move', track: 0, start: 3, duration: 2 }], ['move'], { makeId: () => 'linked-right' });
assert.equal(overwritten.some(item => item.linkGroupId === 'pair'), false, 'an overwrite split must not leave both fragments in the same link group');

const peaks = waveformPeaks([Float32Array.from([0, .2, -.8, .1, .4, -1, .2, 0])], 4);
assert.deepEqual(peaks.map(value => Number(value.toFixed(3))), [.2, .8, 1, .2]);
assert.deepEqual(waveformWindow([0, .2, .4, .6, .8, 1], 2, 4, 6), [.4, .6]);

const history = createTimelineHistory({ limit: 2 });
history.reset({ clips: [] });
assert.equal(history.commit({ clips: [{ id: 'a' }] }), true);
assert.equal(history.commit({ clips: [{ id: 'a' }] }), false, 'identical states must not create undo entries');
history.commit({ clips: [{ id: 'a' }, { id: 'b' }] });
history.commit({ clips: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
assert.deepEqual(history.sizes(), { undo: 2, redo: 0 }, 'history must respect its configured limit');
assert.deepEqual(history.undo().clips.map(clip => clip.id), ['a', 'b']);
assert.deepEqual(history.undo().clips.map(clip => clip.id), ['a']);
assert.equal(history.undo(), null);
assert.deepEqual(history.redo().clips.map(clip => clip.id), ['a', 'b']);
history.commit({ clips: [{ id: 'branch' }] });
assert.equal(history.canRedo(), false, 'a new edit after undo must invalidate redo');

console.log('animatics timeline model tests passed');
