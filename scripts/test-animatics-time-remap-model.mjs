import assert from 'node:assert/strict';
import {
  addTimeRemapKeyframe,
  applyTimeRemapEase,
  averageTimeRemapSpeed,
  constantTimeRemap,
  cropTimeRemappedItem,
  normalizeTimeRemap,
  retimeCurveToDuration,
  reverseTimeRemap,
  setTimeRemapInterpolation,
  timeRemapHandleInfo,
  timeRemapStateAt,
  timeRemapSourceAt,
  timeRemapSpeedAt,
  timeRemapValueAt,
  updateTimeRemapHandle,
  updateTimeRemapKeyframe,
} from './animatics-time-remap-model.mjs';
import { applyBatchTimelineDuration, splitTimelineItem } from './animatics-timeline-model.mjs';

const close = (actual, expected, message, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: expected ${expected}, got ${actual}`);
const clip = {sourceIn:10,sourceOut:20,duration:10};

const identity = normalizeTimeRemap(clip);
assert.equal(identity.enabled, false, 'legacy clips must migrate as disabled identity remaps');
close(timeRemapSourceAt({...clip,timeRemap:identity}, 4), 14, 'identity remap must preserve 1:1 source time');
close(timeRemapSpeedAt({...clip,timeRemap:identity}, 4), 1, 'identity remap must report 100% speed');
const compiledItem={...clip,timeRemap:identity},compiledState=timeRemapStateAt(compiledItem,4),compiledAgain=timeRemapStateAt(compiledItem,6);
close(compiledState.source,timeRemapSourceAt(compiledItem,4),'compiled remap state must share the public source mapping');
close(compiledState.speed,timeRemapSpeedAt(compiledItem,4),'compiled remap state must share the public speed mapping');
assert.strictEqual(compiledState.remap,compiledAgain.remap,'repeated frame evaluation must reuse the compiled normalized curve');
close(timeRemapStateAt({sourceIn:-4,sourceOut:2,duration:2},0).source,0,'compiled evaluation must preserve non-negative source bounds');

const doubled = {...clip,...constantTimeRemap(clip, 2)};
close(doubled.duration, 5, '200% speed must halve duration');
close(timeRemapSourceAt(doubled, 2.5), 15, '200% speed must map the midpoint');
close(averageTimeRemapSpeed(doubled), 2, 'average speed must match constant speed');

const reversed = {...clip,...constantTimeRemap(clip, -2, {reverse:true})};
close(timeRemapSourceAt(reversed, 0), 20, 'reverse must begin at sourceOut');
close(timeRemapSourceAt(reversed, reversed.duration), 10, 'reverse must end at sourceIn');
close(timeRemapSpeedAt(reversed, 1), -2, 'reverse speed must be negative');

let ramp = {...clip,timeRemap:addTimeRemapKeyframe(clip, 5)};
ramp.timeRemap = updateTimeRemapKeyframe(ramp, 1, {value:3,speed:.35});
assert.equal(ramp.timeRemap.keyframes.length, 3, 'graph must add an interior keyframe');
close(timeRemapValueAt(ramp, 5), 3, 'value graph keyframe must be evaluated exactly');
for(let sample=0;sample<=100;sample++) assert.ok(timeRemapSpeedAt(ramp, sample/10) >= -1e-8, 'forward ramp must stay monotone');

const stretched = {...ramp,...retimeCurveToDuration(ramp, 20)};
close(timeRemapSourceAt(stretched, 10), timeRemapSourceAt(ramp, 5), 'duration changes must preserve the curve shape');
close(Math.abs(timeRemapSpeedAt(stretched, 10)), Math.abs(timeRemapSpeedAt(ramp, 5))/2, 'stretching duration must scale speed tangents');

const right = cropTimeRemappedItem(ramp, 5, 10);
close(right.duration, 5, 'cropping must preserve requested timeline duration');
close(right.sourceIn, 13, 'cropping must map source boundaries through the graph');
close(timeRemapSourceAt(right, 0), 13, 'cropped remap must begin at mapped source time');
close(timeRemapSourceAt(right, 5), 20, 'cropped remap must end at original source endpoint');

const reverseRight = cropTimeRemappedItem(reversed, 1, 4);
assert.ok(reverseRight.sourceIn < reverseRight.sourceOut, 'reverse crops must retain ascending source bounds');
assert.ok(timeRemapSourceAt(reverseRight, 0) > timeRemapSourceAt(reverseRight, reverseRight.duration), 'reverse crop direction must be retained');

const timelineRamp={...ramp,id:'ramp',start:4};
const pieces=splitTimelineItem(timelineRamp,9,{makeId:()=> 'right'});
assert.equal(pieces.length,2,'timeline splitting must support remapped media');
close(timeRemapSourceAt(pieces[0],pieces[0].duration),timeRemapSourceAt(pieces[1],0),'split remap pieces must meet on the same source frame');
assert.equal(pieces[1].start,9,'right remap piece must begin at the split time');

const batch=applyBatchTimelineDuration([timelineRamp],['ramp'],20,{maxDuration:()=>600});
assert.equal(batch.changedIds[0],'ramp','duration editor must report remapped changes');
close(timeRemapSourceAt(batch.items[0],10),timeRemapSourceAt(timelineRamp,5),'duration editor must stretch the graph rather than changing source bounds');

const legacyReverse=normalizeTimeRemap(clip,{enabled:true,reverse:true,curve:'linear',keyframes:[{time:0,value:0,speed:1},{time:10,value:10,speed:1}]});
close(legacyReverse.keyframes[0].value,10,'legacy reverse curves must migrate to descending source values');
close(legacyReverse.keyframes[1].value,0,'legacy reverse end value must migrate without changing playback');
close(timeRemapSourceAt({...clip,timeRemap:legacyReverse},0),20,'migrated reverse must begin at the old source out point');

let mixed={...clip,timeRemap:normalizeTimeRemap(clip,{modelVersion:2,enabled:true,keyframes:[
  {time:0,value:0,outInterpolation:'linear'},
  {time:3,value:6,inInterpolation:'linear',outInterpolation:'hold'},
  {time:6,value:6,inInterpolation:'hold',outInterpolation:'linear'},
  {time:10,value:2,inInterpolation:'linear'},
]})};
assert.ok(timeRemapSpeedAt(mixed,1)>0,'an upward Value Graph segment must play forward');
close(timeRemapSpeedAt(mixed,4),0,'a Hold segment must freeze the source frame');
close(timeRemapValueAt(mixed,6),6,'a Hold segment must jump to the next keyframe value at the keyframe');
assert.ok(timeRemapSpeedAt(mixed,8)<0,'a downward Value Graph segment must play in reverse');
const splitHold={...mixed,timeRemap:addTimeRemapKeyframe(mixed,4.5)};
close(timeRemapValueAt(splitHold,4),6,'adding a keyframe inside a Hold segment must preserve its frozen value');
close(timeRemapValueAt(splitHold,5),6,'splitting Hold interpolation must not introduce a ramp');

let handled={...clip,timeRemap:addTimeRemapKeyframe(clip,5)};
handled.timeRemap=updateTimeRemapHandle(handled,1,'in',{speed:.25,influence:40,split:true});
handled.timeRemap=updateTimeRemapHandle(handled,1,'out',{speed:1.75,influence:55,split:true});
let handleInfo=timeRemapHandleInfo(handled,1);
close(handleInfo.in.speed,.25,'incoming handle vertical position must control incoming speed');
close(handleInfo.in.influence,40,'incoming handle horizontal reach must control influence');
close(handleInfo.out.speed,1.75,'split outgoing handle must remain independent');
close(handleInfo.out.influence,55,'outgoing influence must remain independent');

handled.timeRemap=applyTimeRemapEase(handled,1,'both');
handleInfo=timeRemapHandleInfo(handled,1);
close(handleInfo.in.speed,0,'Easy Ease must set incoming speed to zero');
close(handleInfo.out.speed,0,'Easy Ease must set outgoing speed to zero');
close(handleInfo.in.influence,33.333,'Easy Ease must use After Effects-style one-third influence',1e-3);
close(handleInfo.out.influence,33.333,'Easy Ease must use one-third outgoing influence',1e-3);

handled.timeRemap=setTimeRemapInterpolation(handled,1,'continuous');
assert.equal(handled.timeRemap.keyframes[1].continuous,true,'Continuous Bézier must join both temporal handles');
handled.timeRemap=updateTimeRemapHandle(handled,1,'out',{speed:.8,influence:28});
handleInfo=timeRemapHandleInfo(handled,1);
close(handleInfo.in.speed,.8,'joined handle edits must preserve equal incoming and outgoing slopes');

let directional={...clip,timeRemap:addTimeRemapKeyframe(clip,5)};
directional.timeRemap=updateTimeRemapHandle(directional,1,'out',{dt:-1,dv:-2,split:true});
assert.ok(directional.timeRemap.keyframes[1].outHandle.dt>0&&directional.timeRemap.keyframes[1].outHandle.dt<.02,'an outgoing handle dragged across its keyframe must pin instead of reflecting');
directional.timeRemap=updateTimeRemapHandle(directional,1,'in',{dt:1,dv:2,split:true});
assert.ok(directional.timeRemap.keyframes[1].inHandle.dt<0&&directional.timeRemap.keyframes[1].inHandle.dt>-.02,'an incoming handle dragged across its keyframe must pin instead of reflecting');

let unclipped={...clip,timeRemap:addTimeRemapKeyframe(clip,5)};
unclipped.timeRemap=updateTimeRemapKeyframe(unclipped,1,{value:10});
unclipped.timeRemap=updateTimeRemapHandle(unclipped,1,'out',{dt:.01,dv:-12,split:true});
close(unclipped.timeRemap.keyframes[1].outHandle.dv,-12,'Value Graph control points must remain draggable beyond the source-value boundary');
assert.ok(timeRemapSourceAt(unclipped,7)>=clip.sourceIn&&timeRemapSourceAt(unclipped,7)<=clip.sourceOut,'playback evaluation must remain clamped even when a control point leaves the visible source range');

let authoritative={...clip,timeRemap:addTimeRemapKeyframe(clip,5)};
authoritative.timeRemap=updateTimeRemapHandle(authoritative,2,'in',{influence:80,speed:1,split:true});
authoritative.timeRemap=updateTimeRemapHandle(authoritative,1,'out',{influence:80,speed:1,split:true});
const draggedInfo=timeRemapHandleInfo(authoritative,1),opposingInfo=timeRemapHandleInfo(authoritative,2);
close(draggedInfo.out.influence,80,'the actively dragged handle must retain its requested influence');
close(opposingInfo.in.influence,18,'only the opposing segment handle should shrink when temporal controls would cross');

const reversedCurve={...handled,timeRemap:reverseTimeRemap(handled)};
for(let index=0;index<=20;index++)close(timeRemapSourceAt(reversedCurve,index/2),30-timeRemapSourceAt(handled,index/2),'reverse shortcut must mirror the unified Value Graph',1e-5);

const derivativeProbe={...clip,timeRemap:updateTimeRemapHandle({...clip,timeRemap:addTimeRemapKeyframe(clip,5)},1,'out',{speed:1.6,influence:42,split:true})};
for(const time of [1,2.5,4.8,5.2,7.5,9]){const epsilon=1e-4,numerical=(timeRemapValueAt(derivativeProbe,time+epsilon)-timeRemapValueAt(derivativeProbe,time-epsilon))/(2*epsilon);close(timeRemapSpeedAt(derivativeProbe,time),numerical,'Speed Graph must be the derivative of the Value Graph',2e-3);}
let integral=0,previous=timeRemapSpeedAt(derivativeProbe,0),steps=2000;
for(let index=1;index<=steps;index++){const time=clip.duration*index/steps,current=timeRemapSpeedAt(derivativeProbe,time);integral+=(previous+current)/2*clip.duration/steps;previous=current;}
close(integral,timeRemapValueAt(derivativeProbe,clip.duration)-timeRemapValueAt(derivativeProbe,0),'area under the Speed Graph must equal the Value Graph change',2e-3);

const beforeSplit=Array.from({length:41},(_,index)=>timeRemapValueAt(derivativeProbe,index/4));
const splitCurve={...derivativeProbe,timeRemap:addTimeRemapKeyframe(derivativeProbe,3.37)};
beforeSplit.forEach((value,index)=>close(timeRemapValueAt(splitCurve,index/4),value,'adding a keyframe must not alter the existing curve',2e-5));

console.log('animatics time remap model tests passed');
