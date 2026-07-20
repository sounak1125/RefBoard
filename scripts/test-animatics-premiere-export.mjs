import assert from 'node:assert/strict';
import {
  buildPremiereTimeline,
  createPremiereXml,
  premiereFileUrl,
  premiereFrame,
  safePremiereAssetName,
} from './animatics-premiere-export.mjs';

assert.equal(premiereFrame(1.5, 24), 36);
assert.equal(premiereFrame(1 / 60, 60), 1);
assert.equal(premiereFileUrl('C:\\Exports\\My Project\\shot #1.png'), 'file://localhost/C:/Exports/My%20Project/shot%20%231.png');
assert.equal(premiereFileUrl('\\\\server\\share\\clip.mov'), 'file://server/share/clip.mov');
assert.equal(safePremiereAssetName('bad<>:"/\\|?*.mov'), 'bad_________.mov');

const project = {
  fps: 24,
  videoTracks: 2,
  videoTrackEnabled: [true, false],
  videoTrackLocked: [false, true],
  audioTracks: 1,
  audioTrackMuted: [true],
  audioTrackSolo: [false],
  audioTrackLocked: [true],
  textTrackLocked: true,
  clips: [
    { id:'still', itemId:'image-1', sourceAssetKey:'image-1-transformed', mediaKind:'image', track:0, start:0, duration:3, name:'Board & Shot.png', enabled:false, framing:{fit:'contain',scale:1,x:0,y:0}, strokes:[{points:[{x:0,y:0}]}] },
    { id:'video', mediaId:'video-1', mediaKind:'video', track:1, start:2, duration:4, sourceIn:10, sourceOut:14, name:'Take <1>.mp4', framing:{fit:'cover',scale:1.2,x:.1,y:-.1} },
  ],
  texts:[{ id:'title', start:1, duration:2, content:'Title &\nSubtitle', name:'Title', size:48, color:'#3af09c', fontFamily:'Montserrat', fontStyle:'SemiBold Italic', fontWeight:600, fontFullName:'Montserrat SemiBold Italic', fontPostscriptName:'Montserrat-SemiBoldItalic', bold:true, italic:true, align:'left', background:true, scale:1.25, rotation:12, x:.25, y:.8 }],
  audio:[{ id:'music', mediaId:'audio-1', track:0, start:.5, duration:5, sourceIn:2, sourceOut:7, volume:.5, fadeInDuration:2, fadeOutDuration:1, fadeInCurve:'constant-power', fadeOutCurve:'exponential', name:'Music.wav' }],
};

const assets = new Map([
  ['image:image-1-transformed', { id:'image-1', kind:'image', category:'image', name:'Board & Shot.png', filePath:'C:\\Export\\Media\\Images\\Board & Shot.png', durationFrames:144, width:4000, height:3000 }],
  ['video:video-1', { id:'video-1', kind:'video', category:'video', name:'Take <1>.mp4', filePath:'C:\\Export\\Media\\Videos\\Take 1.mp4', durationFrames:480, width:3840, height:2160 }],
  ['audio:audio-1', { id:'audio-1', kind:'audio', category:'audio', name:'Music.wav', filePath:'C:\\Export\\Media\\Audio\\Music.wav', durationFrames:240, channels:2 }],
  ['stroke:still', { id:'stroke-still', kind:'image', category:'drawing', name:'Board Shot Drawings.png', filePath:'C:\\Export\\Media\\Drawings\\Board Shot Drawings.png', durationFrames:144, width:1920, height:1080 }],
]);

const timeline = buildPremiereTimeline({ project, name:'Animatic & Cut', fps:24, width:1920, height:1080, exportStart:1, exportEnd:5, assets });
const title = timeline.videoTracks.flat().find(clip => clip.id === 'title');
assert.deepEqual(
  { fontFamily:title.text.fontFamily, fontStyle:title.text.fontStyle, fontWeight:title.text.fontWeight, fontFullName:title.text.fontFullName, fontPostscriptName:title.text.fontPostscriptName, bold:title.text.bold, italic:title.text.italic, align:title.text.align, background:title.text.background },
  { fontFamily:'Montserrat', fontStyle:'SemiBold Italic', fontWeight:600, fontFullName:'Montserrat SemiBold Italic', fontPostscriptName:'Montserrat-SemiBoldItalic', bold:true, italic:true, align:'left', background:true },
  'Premiere text clips must retain the selected character and background settings',
);
assert.equal(timeline.durationFrames, 96);
assert.equal(timeline.videoTracks.length, 4, 'two source tracks plus drawing and text overlay tracks');
assert.deepEqual(timeline.videoTrackEnabled, [true,false,true,true], 'source track visibility must follow derived overlay tracks');
assert.deepEqual(timeline.videoTrackLocked, [false,true,false,true], 'track locks must follow derived drawing and text tracks');
assert.equal(timeline.audioTracks.length, 1);
assert.deepEqual(timeline.audioTrackEnabled,[false], 'muted RefBoard audio tracks must be disabled in Premiere');
assert.deepEqual(timeline.audioTrackLocked,[true], 'audio locks must survive Premiere export');
assert.equal(timeline.videoTracks[0][0].start, 0);
assert.equal(timeline.videoTracks[0][0].end, 48);
assert.equal(timeline.videoTracks[0][0].enabled, false, 'disabled visual clips must remain disabled in Premiere');
assert.equal(timeline.videoTracks[1][0].start, 24);
assert.equal(timeline.videoTracks[1][0].in, 240, 'video source In point is preserved when its clip starts inside the range');
assert.equal(timeline.audioTracks[0][0].start, 0);
assert.equal(timeline.audioTracks[0][0].in, 60, 'range trimming advances the audio source In point');
assert.ok(timeline.audioTracks[0][0].audioEnvelope.length > 10, 'Premiere timing model must sample RefBoard audio fades');
assert.equal(timeline.audioTracks[0][0].audioEnvelope[0].when, 0, 'range-trimmed fade automation must begin at the exported clip boundary');

const output = createPremiereXml(timeline);
assert.match(output, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
assert.match(output, /<xmeml version="5">/);
assert.match(output, /<name>Animatic &amp; Cut<\/name>/);
const sparseTrackOutput = createPremiereXml({
  ...timeline,
  videoTracks:[[], timeline.videoTracks[0]],
  videoTrackEnabled:[false, true],
  videoTrackLocked:[true, false],
  audioTracks:[[], timeline.audioTracks[0], []],
  audioTrackEnabled:[true, false, true],
  audioTrackLocked:[false, true, false],
});
const sparseTracks = [...sparseTrackOutput.matchAll(/<track>([\s\S]*?)<\/track>/g)].map(match => match[1]);
assert.doesNotMatch(sparseTrackOutput, /<track><enabled>(?:TRUE|FALSE)<\/enabled><locked>(?:TRUE|FALSE)<\/locked><\/track>/, 'Premiere XML must not contain empty tracks');
assert.equal(sparseTracks.length, 2, 'only tracks containing clips should be emitted');
assert.match(sparseTracks.find(track => track.includes('Board &amp; Shot.png')) || '', /<enabled>TRUE<\/enabled><locked>FALSE<\/locked>$/, 'a filtered video track must retain enabled and locked state from its original index');
assert.match(sparseTracks.find(track => track.includes('Music.wav')) || '', /<enabled>FALSE<\/enabled><locked>TRUE<\/locked>$/, 'a filtered audio track must retain enabled and locked state from its original index');
for (const bin of ['Images','Videos','Audio','Drawings','Sequences']) assert.match(output, new RegExp(`<bin><name>${bin}<\\/name><children>`), `${bin} must import into its own Premiere bin`);
assert.match(output, /<clip id="masterclip-image-1">[\s\S]*?<ismasterclip>TRUE<\/ismasterclip>/, 'collected media must be represented as organized master clips');
assert.match(output, /<masterclipid>masterclip-video-1<\/masterclipid>/, 'timeline clips must link back to their organized master clips');
assert.match(output, /<clipitem id="clipitem-still-[^"]+">[\s\S]*?<enabled>FALSE<\/enabled>/, 'Premiere clipitems must preserve individual visibility');
assert.match(output, /<track>[\s\S]*?Take &lt;1&gt;\.mp4[\s\S]*?<enabled>FALSE<\/enabled><locked>TRUE<\/locked><\/track>/, 'Premiere video tracks must preserve visibility and locks');
assert.match(output, /<track>[\s\S]*?Music\.wav[\s\S]*?<enabled>FALSE<\/enabled><locked>TRUE<\/locked><\/track>/, 'Premiere audio tracks must preserve effective mute and locks');
assert.match(output, /<width>1920<\/width><height>1080<\/height>/);
assert.match(output, /<timebase>24<\/timebase><ntsc>FALSE<\/ntsc>/);
assert.match(output, /Board%20%26%20Shot\.png/);
assert.match(output, /Take &lt;1&gt;\.mp4/);
assert.match(output, /<name>Basic Motion<\/name>/);
assert.match(output, /<horiz>0\.100000<\/horiz><vert>-0\.100000<\/vert>/, 'framing center must use normalized offsets rather than sequence pixels');
assert.doesNotMatch(output, /<horiz>\d{3,}\./, 'Basic Motion must never place images using large pixel coordinates');
assert.match(output, /<name>Audio Levels<\/name>/);
assert.match(output, /<keyframe><when>0<\/when><value>0\.191342<\/value><interp>linear<\/interp><\/keyframe>/, 'Premiere must receive timeline Audio Levels keyframes for fades');
assert.ok((output.match(/<keyframe>/g) || []).length > 10, 'curved fades must be represented with enough Premiere keyframes');
assert.match(output, /<generatoritem id="generatoritem-title-/, 'text layers must export as editable title generators');
assert.match(output, /<parameterid>str<\/parameterid><name>Text<\/name><value>Title &amp;&#13;Subtitle<\/value>/);
assert.match(output, /<parameterid>fontname<\/parameterid><name>Font<\/name><value>Montserrat-SemiBoldItalic<\/value>/, 'Premiere text must prefer the exact selected PostScript font face');
assert.match(output, /<parameterid>fontstyle<\/parameterid>[\s\S]*?<value>4<\/value>/, 'Premiere text must map bold plus italic to style enum 4');
assert.match(output, /<parameterid>fontalign<\/parameterid>[\s\S]*?<value>1<\/value>/, 'Premiere text must map left alignment to enum 1');
assert.doesNotMatch(output, /<parameterid>background<\/parameterid>/, 'Premiere XMEML must not emit an unsupported text-background parameter');
assert.match(output, /<parameterid>fontsize<\/parameterid>[\s\S]*?<value>90\.000000<\/value>/, 'text scale and sequence width must remain editable through generator font size');
const portraitOutput = createPremiereXml({ ...timeline, width:1080, height:1920 });
assert.match(portraitOutput, /<parameterid>fontsize<\/parameterid>[\s\S]*?<value>50\.625000<\/value>/, 'Premiere text size must follow portrait sequence dimensions');
assert.match(output, /<parameterid>fontcolor<\/parameterid>[\s\S]*?<red>58<\/red><green>240<\/green><blue>156<\/blue>/);
assert.match(output, /<parameterid>origin<\/parameterid>[\s\S]*?<horiz>-0\.250000<\/horiz><vert>0\.300000<\/vert>/);
assert.match(output, /<parameterid>rotation<\/parameterid>[\s\S]*?<value>12\.000000<\/value>/);
assert.doesNotMatch(output, /Title\.png/, 'editable text must not be rasterized into collected PNG media');
assert.equal((output.match(/<file id="file-image-1"><name>/g) || []).length, 1, 'reused media must be described once');

const convertedImageProject = {
  ...project,
  videoTracks:1,
  videoTrackEnabled:[true],
  videoTrackLocked:[false],
  audioTracks:0,
  audioTrackMuted:[],
  audioTrackSolo:[],
  audioTrackLocked:[],
  textTrackLocked:false,
  clips:[{ ...project.clips[0], name:'Converted Source.jpeg', strokes:[] }],
  texts:[],
  audio:[],
};
const convertedImageAssets = new Map([
  ['image:image-1-transformed', { id:'converted-image-1', kind:'image', category:'image', name:'Converted Source.png', filePath:'C:\\Export\\Media\\Images\\Converted Source.png', durationFrames:72, width:1920, height:1080 }],
]);
const convertedImageOutput = createPremiereXml(buildPremiereTimeline({ project:convertedImageProject, name:'Converted Image', fps:24, width:1920, height:1080, exportStart:0, exportEnd:3, assets:convertedImageAssets }));
const convertedImageMasterNames = new Map(
  [...convertedImageOutput.matchAll(/<clip id="(masterclip-[^"]+)"><name>([^<]*)<\/name>/g)].map(match => [match[1], match[2]]),
);
const convertedImageClipitems = [...convertedImageOutput.matchAll(/<clipitem id="[^"]+"><name>([^<]*)<\/name>[\s\S]*?<masterclipid>([^<]+)<\/masterclipid>/g)];
assert.ok(convertedImageClipitems.length > 0, 'converted-image fixture must produce an image clipitem');
for (const [, clipitemName, masterclipId] of convertedImageClipitems) {
  assert.equal(clipitemName, convertedImageMasterNames.get(masterclipId), 'each image clipitem name must exactly match its referenced master clip name');
}
assert.doesNotMatch(convertedImageOutput, /<clipitem id="[^"]+"><name>Converted Source\.jpeg<\/name>/, 'converted image clipitems must not retain the pre-conversion extension');

const legacyProject = {
  ...project,
  texts:[{ ...project.texts[0], fontFamily:undefined, fontStyle:undefined, fontWeight:undefined, fontFullName:undefined, fontPostscriptName:undefined, bold:undefined, italic:undefined, align:undefined, background:undefined }],
};
const legacyTimeline = buildPremiereTimeline({ project:legacyProject, name:'Legacy Text', fps:24, width:1920, height:1080, exportStart:1, exportEnd:5, assets });
const legacyTitle = legacyTimeline.videoTracks.flat().find(clip => clip.id === 'title');
assert.equal(legacyTitle.text.background, false, 'older Premiere text must default the background plate off');
const legacyOutput = createPremiereXml(legacyTimeline);
assert.match(legacyOutput, /<parameterid>fontname<\/parameterid><name>Font<\/name><value>Segoe UI<\/value>/, 'older Premiere text must default to Segoe UI');
assert.match(legacyOutput, /<parameterid>fontstyle<\/parameterid>[\s\S]*?<value>1<\/value>/, 'older Premiere text must default to plain style enum 1');
assert.match(legacyOutput, /<parameterid>fontalign<\/parameterid>[\s\S]*?<value>2<\/value>/, 'older Premiere text must default to centered alignment enum 2');

const trimmedClipProject = {
  ...project,
  videoTracks:1,
  videoTrackEnabled:[true],
  videoTrackLocked:[false],
  audioTracks:0,
  audioTrackMuted:[],
  audioTrackSolo:[],
  audioTrackLocked:[],
  textTrackLocked:false,
  clips:[{ id:'trimmed', itemId:'image-1', sourceAssetKey:'trimmed-image', mediaKind:'image', track:0, start:0, duration:70 / 24, name:'Trimmed Source.png', strokes:[] }],
  texts:[],
  audio:[],
};
const trimmedClipAssets = new Map([
  ['image:trimmed-image', { id:'trimmed-image-1', kind:'image', category:'image', name:'Trimmed Source.png', filePath:'C:\\Export\\Media\\Images\\Trimmed Source.png', durationFrames:72, width:1920, height:1080 }],
]);
const trimmedClipOutput = createPremiereXml(buildPremiereTimeline({ project:trimmedClipProject, name:'Trimmed Clip', fps:24, width:1920, height:1080, exportStart:0, exportEnd:70 / 24, assets:trimmedClipAssets }));
const trimmedClipitem = trimmedClipOutput.match(/<clipitem id="clipitem-trimmed-[^"]+">([\s\S]*?)<\/clipitem>/);
assert.ok(trimmedClipitem, 'trimmed fixture must produce a timeline clipitem');
const trimmedDuration = Number(trimmedClipitem[1].match(/<duration>(\d+)<\/duration>/)?.[1]);
const trimmedStart = Number(trimmedClipitem[1].match(/<start>(\d+)<\/start>/)?.[1]);
const trimmedEnd = Number(trimmedClipitem[1].match(/<end>(\d+)<\/end>/)?.[1]);
const trimmedIn = Number(trimmedClipitem[1].match(/<in>(\d+)<\/in>/)?.[1]);
const trimmedOut = Number(trimmedClipitem[1].match(/<out>(\d+)<\/out>/)?.[1]);
assert.equal(trimmedEnd - trimmedStart, 70, 'trimmed clip must place a 70-frame span on the timeline');
assert.equal(trimmedOut - trimmedIn, 70, 'trimmed clip must use a 70-frame source range');
assert.equal(trimmedDuration, trimmedEnd - trimmedStart, 'clipitem duration must equal end - start for trimmed clips');
assert.equal(trimmedDuration, trimmedOut - trimmedIn, 'clipitem duration must equal out - in for trimmed clips');
assert.match(trimmedClipOutput, /<clip id="masterclip-trimmed-image-1"><name>Trimmed Source\.png<\/name><duration>72<\/duration>/, 'masterclip duration must still reflect the full asset');

console.log('animatics Premiere export tests passed');
