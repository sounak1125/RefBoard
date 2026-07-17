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
  texts:[{ id:'title', start:1, duration:2, content:'Title &\nSubtitle', name:'Title', size:48, color:'#3af09c', scale:1.25, rotation:12, x:.25, y:.8 }],
  audio:[{ id:'music', mediaId:'audio-1', track:0, start:.5, duration:5, sourceIn:2, sourceOut:7, volume:.5, name:'Music.wav' }],
};

const assets = new Map([
  ['image:image-1-transformed', { id:'image-1', kind:'image', category:'image', name:'Board & Shot.png', filePath:'C:\\Export\\Media\\Images\\Board & Shot.png', durationFrames:144, width:4000, height:3000 }],
  ['video:video-1', { id:'video-1', kind:'video', category:'video', name:'Take <1>.mp4', filePath:'C:\\Export\\Media\\Videos\\Take 1.mp4', durationFrames:480, width:3840, height:2160 }],
  ['audio:audio-1', { id:'audio-1', kind:'audio', category:'audio', name:'Music.wav', filePath:'C:\\Export\\Media\\Audio\\Music.wav', durationFrames:240, channels:2 }],
  ['stroke:still', { id:'stroke-still', kind:'image', category:'drawing', name:'Board Shot Drawings.png', filePath:'C:\\Export\\Media\\Drawings\\Board Shot Drawings.png', durationFrames:144, width:1920, height:1080 }],
]);

const timeline = buildPremiereTimeline({ project, name:'Animatic & Cut', fps:24, width:1920, height:1080, exportStart:1, exportEnd:5, assets });
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

const output = createPremiereXml(timeline);
assert.match(output, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
assert.match(output, /<xmeml version="5">/);
assert.match(output, /<name>Animatic &amp; Cut<\/name>/);
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
assert.match(output, /<generatoritem id="generatoritem-title-/, 'text layers must export as editable title generators');
assert.match(output, /<parameterid>str<\/parameterid><name>Text<\/name><value>Title &amp;&#13;Subtitle<\/value>/);
assert.match(output, /<parameterid>fontsize<\/parameterid>[\s\S]*?<value>60\.000000<\/value>/, 'text scale must remain editable through generator font size');
assert.match(output, /<parameterid>fontcolor<\/parameterid>[\s\S]*?<red>58<\/red><green>240<\/green><blue>156<\/blue>/);
assert.match(output, /<parameterid>origin<\/parameterid>[\s\S]*?<horiz>-0\.250000<\/horiz><vert>0\.300000<\/vert>/);
assert.match(output, /<parameterid>rotation<\/parameterid>[\s\S]*?<value>12\.000000<\/value>/);
assert.doesNotMatch(output, /Title\.png/, 'editable text must not be rasterized into collected PNG media');
assert.equal((output.match(/<file id="file-image-1"><name>/g) || []).length, 1, 'reused media must be described once');

console.log('animatics Premiere export tests passed');
