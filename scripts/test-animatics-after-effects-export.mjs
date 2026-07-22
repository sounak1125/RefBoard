import assert from 'node:assert/strict';
import {
  AFTER_EFFECTS_MAX_SECONDS,
  afterEffectsTime,
  buildAfterEffectsProject,
  createAfterEffectsScript,
} from './animatics-after-effects-export.mjs';

assert.equal(afterEffectsTime(1.5, 24), 1.5);
assert.equal(afterEffectsTime(1 / 60, 60), 1 / 60);
assert.equal(afterEffectsTime(1.02, 24), 1, 'timeline values must snap to the selected composition frame rate');
assert.equal(AFTER_EFFECTS_MAX_SECONDS, 10800);

const project = {
  fps: 24,
  background: '#102030',
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
    { id:'video', mediaId:'video-1', mediaKind:'video', track:1, start:2, duration:4, sourceIn:10, sourceOut:14, name:'Take <1>.mp4', framing:{fit:'cover',scale:1.2,x:.1,y:-.1}, linkGroupId:'linked-1' },
  ],
  texts:[{ id:'title', start:1, duration:2, content:'Title &\nSubtitle', name:'Title', size:48, color:'#3af09c', fontFamily:'Montserrat', fontStyle:'SemiBold Italic', fontWeight:600, fontFullName:'Montserrat SemiBold Italic', fontPostscriptName:'Montserrat-SemiBoldItalic', bold:true, italic:true, align:'right', background:true, scale:1.25, rotation:12, x:.25, y:.8 }],
  audio:[{ id:'music', mediaId:'audio-1', track:0, start:.5, duration:5, sourceIn:2, sourceOut:7, volume:.5, fadeInDuration:2, fadeOutDuration:1, fadeInCurve:'constant-power', fadeOutCurve:'exponential', name:'Music.wav', linkGroupId:'linked-1' }],
};

const assets = new Map([
  ['image:image-1-transformed', { id:'image-1', kind:'image', category:'image', name:'Board & Shot.png', relativePath:'Images/Board & Shot.png', filePath:'C:\\Export\\Media\\Images\\Board & Shot.png', durationFrames:144, width:4000, height:3000 }],
  ['video:video-1', { id:'video-1', kind:'video', category:'video', name:'Take _1_.mp4', relativePath:'Videos/Take _1_.mp4', filePath:'C:\\Export\\Media\\Videos\\Take _1_.mp4', durationFrames:480, width:3840, height:2160 }],
  ['audio:audio-1', { id:'audio-1', kind:'audio', category:'audio', name:'Music.wav', relativePath:'Audio/Music.wav', filePath:'C:\\Export\\Media\\Audio\\Music.wav', durationFrames:240, channels:2 }],
  ['stroke:still', { id:'stroke-still', kind:'image', category:'drawing', name:'Board Shot Drawings.png', relativePath:'Drawings/Board Shot Drawings.png', filePath:'C:\\Export\\Media\\Drawings\\Board Shot Drawings.png', durationFrames:144, width:1920, height:1080 }],
]);

const output = buildAfterEffectsProject({ project, name:'Animatic & Cut', fps:24, width:1920, height:1080, exportStart:1, exportEnd:5, assets });
assert.throws(
  () => buildAfterEffectsProject({ project, name:'Too Long', fps:24, width:1920, height:1080, exportStart:0, exportEnd:AFTER_EFFECTS_MAX_SECONDS + 1, assets }),
  /limited to three hours/,
);
assert.equal(output.duration, 4);
assert.deepEqual(output.background, [0.062745, 0.12549, 0.188235]);
assert.equal(output.assets.length, 4, 'reused footage must be imported only once');
assert.deepEqual(output.assets.map(asset => asset.category).sort(), ['audio','drawing','image','video']);
assert.ok(output.assets.some(asset => asset.relativePath === 'Drawings/Board Shot Drawings.png'));
assert.equal(output.layers.length, 5, 'audio, two visuals, drawing overlay, and editable text must all be emitted');

const still = output.layers.find(layer => layer.id === 'still');
const video = output.layers.find(layer => layer.id === 'video');
const music = output.layers.find(layer => layer.id === 'music');
const text = output.layers.find(layer => layer.id === 'title');
assert.equal(still.start, 0);
assert.equal(still.end, 2);
assert.equal(still.enabled, false, 'individual clip visibility must survive After Effects export');
assert.deepEqual(still.transform.scale, [36, 36], 'Fit framing must become an After Effects layer scale');
assert.equal(video.start, 1);
assert.equal(video.enabled, false, 'disabled video tracks must disable their After Effects layers');
assert.equal(video.locked, true, 'video track locks must survive After Effects export');
assert.equal(video.sourceIn, 10, 'source In must remain non-destructive when exporting a range');
assert.deepEqual(video.transform.position, [1056, 486]);
assert.deepEqual(video.transform.scale, [60, 60], 'Fill framing and user scale must be combined accurately');
assert.equal(music.start, 0);
assert.equal(music.sourceIn, 2.5, 'range trimming must advance the audio source In point');
assert.equal(music.audioDb, -6.0206, 'linear RefBoard audio gain must be converted to After Effects decibels');
assert.ok(music.audioEnvelope.length > 10, 'After Effects model must sample curved RefBoard audio fades');
assert.deepEqual(music.audioEnvelope[0], { time:0, db:-14.363807 }, 'range-trimmed fade automation must begin at the exported layer boundary');
assert.equal(music.enabled, false, 'muted RefBoard audio tracks must disable After Effects audio layers');
assert.equal(music.locked, true, 'audio track locks must survive After Effects export');
assert.equal(text.text.content, 'Title &\nSubtitle');
assert.equal(text.text.fontSize, 72);
assert.equal(text.text.fontFamily, 'Montserrat');
assert.equal(text.text.fontStyle, 'SemiBold Italic');
assert.equal(text.text.fontWeight, 600);
assert.equal(text.text.fontFullName, 'Montserrat SemiBold Italic');
assert.equal(text.text.fontPostscriptName, 'Montserrat-SemiBoldItalic');
assert.equal(text.text.bold, true);
assert.equal(text.text.italic, true);
assert.equal(text.text.align, 'right');
assert.equal(text.text.background, true);
assert.deepEqual(text.transform.scale, [125, 125]);
assert.deepEqual(text.transform.position, [480, 864]);
assert.equal(text.locked, true, 'text track locks must survive After Effects export');
const portraitText = buildAfterEffectsProject({ project, name:'Portrait Text', fps:24, width:1080, height:1920, exportStart:1, exportEnd:5, assets }).layers.find(layer => layer.id === 'title');
assert.equal(portraitText.text.fontSize, 40.5, 'After Effects text size must follow portrait composition dimensions');
assert.deepEqual(portraitText.transform.position, [270, 1536], 'After Effects text position must follow portrait composition dimensions');

const legacyProject = {
  ...project,
  texts:[{ ...project.texts[0], fontFamily:undefined, fontStyle:undefined, fontWeight:undefined, fontFullName:undefined, fontPostscriptName:undefined, bold:undefined, italic:undefined, align:undefined, background:undefined }],
};
const legacyText = buildAfterEffectsProject({ project:legacyProject, name:'Legacy Text', fps:24, width:1920, height:1080, exportStart:1, exportEnd:5, assets }).layers.find(layer => layer.id === 'title');
assert.deepEqual(
  { fontFamily:legacyText.text.fontFamily, bold:legacyText.text.bold, italic:legacyText.text.italic, align:legacyText.text.align, background:legacyText.text.background },
  { fontFamily:'Segoe UI', bold:false, italic:false, align:'center', background:false },
  'older text layers must receive export-safe character and background defaults',
);

const remappedProject=structuredClone(project),remappedVideo=remappedProject.clips.find(clip=>clip.id==='video');remappedVideo.duration=2;remappedVideo.timeRemap={enabled:true,reverse:true,preservePitch:true,frameInterpolation:'sampling',curve:'bezier',keyframes:[{time:0,value:0,speed:2},{time:1,value:1,speed:.5},{time:2,value:4,speed:2}]};
const remappedOutput=buildAfterEffectsProject({project:remappedProject,name:'Remapped Cut',fps:24,width:1920,height:1080,exportStart:0,exportEnd:5,assets}),remappedLayer=remappedOutput.layers.find(layer=>layer.id==='video');
assert.ok(remappedLayer.timeRemap.length>=16,'After Effects variable ramps must be sampled into editable keyframes');
assert.ok(remappedLayer.timeRemap[0].value>remappedLayer.timeRemap.at(-1).value,'After Effects reverse remaps must descend through source time');

const script = createAfterEffectsScript(output, {
  mediaFolderName: 'Animatic & Cut_Media',
  projectFileName: 'Animatic & Cut.aep',
});
assert.match(script, /^#target aftereffects/);
assert.match(script, /RefBoard After Effects Project Builder/);
assert.match(script, /app\.project\.items\.addComp/);
assert.match(script, /app\.project\.importFile\(new ImportOptions\(sourceFile\)\)/);
const remappedScript=createAfterEffectsScript(remappedOutput,{mediaFolderName:'Remapped_Media',projectFileName:'Remapped.aep'});assert.match(remappedScript,/layer\.timeRemapEnabled = true/,'After Effects builder must enable layer time remapping');assert.match(remappedScript,/ADBE Time Remapping/,'After Effects builder must write editable remap keyframes');
assert.match(script, /addFolder\("RefBoard Animatic"\)/, 'After Effects project items must live under a RefBoard root folder');
assert.match(script, /categoryNames = \{ image:"Images", video:"Videos", audio:"Audio", drawing:"Drawings" \}/, 'After Effects media must be sorted into project-panel folders');
assert.match(script, /asset\.relativePath/, 'the builder must import from categorized on-disk media folders');
assert.match(script, /"relativePath":"Images\/Board & Shot\.png"/);
assert.match(script, /sourceRectAtTime/, 'text must stay editable and receive a centered anchor point');
assert.match(script, /var exactFont = spec\.text\.fontPostscriptName \|\| spec\.text\.fontFullName \|\| ""/, 'After Effects text must resolve an exact installed face before falling back to a family');
assert.match(script, /documentValue\.font = exactFont \|\| spec\.text\.fontFamily \|\| "Segoe UI"/, 'After Effects text must use the exact selected font face');
assert.match(script, /documentValue\.fauxBold = !exactFont && \(spec\.text\.fontWeight >= 600 \|\| spec\.text\.bold === true\)/, 'After Effects must only synthesize bold when no exact face is available');
assert.match(script, /documentValue\.fauxItalic = !exactFont && spec\.text\.italic === true/, 'After Effects must only synthesize italic when no exact face is available');
assert.match(script, /ParagraphJustification\.RIGHT_JUSTIFY/, 'After Effects text must map right alignment to paragraph justification');
assert.match(script, /"fontFamily":"Montserrat"/, 'selected font family metadata must be embedded in the JSX payload');
assert.match(script, /"fontPostscriptName":"Montserrat-SemiBoldItalic"/, 'selected exact font-face metadata must be embedded in the JSX payload');
assert.match(script, /"background":true/, 'enabled text background metadata must be embedded in the JSX payload');
assert.match(script, /ADBE Vector Shape - Rect/, 'After Effects text backgrounds must use an editable rectangle shape');
assert.match(script, /ADBE Vector Fill Color"\)\.setValue\(\[0, 0, 0\]\)/, 'After Effects text backgrounds must be black');
assert.match(script, /ADBE Vector Fill Opacity"\)\.setValue\(58\)/, 'After Effects text backgrounds must match the in-app 58% opacity');
assert.match(script, /setTransform\(plate, spec\.transform\)/, 'After Effects text backgrounds must share the text transform');
assert.match(script, /plate\.moveAfter\(layer\)/, 'After Effects text backgrounds must be ordered behind their text layer');
assert.match(script, /ADBE Audio Levels/, 'audio gain must be applied in After Effects');
assert.match(script, /audioLevels\.setValueAtTime\(audioPoint\.time, \[audioPoint\.db, audioPoint\.db\]\)/, 'audio fades must become editable After Effects Audio Levels keyframes');
assert.match(script, /layer\.enabled = spec\.enabled !== false;/, 'After Effects layers must preserve RefBoard visibility');
assert.match(script, /layer\.locked = spec\.locked === true;/, 'After Effects layers must preserve RefBoard track locks');
assert.match(script, /spec\.start - spec\.sourceIn/, 'video and audio source trims must be preserved');
assert.ok(script.indexOf('layer.startTime =') < script.indexOf('layer.inPoint ='), 'source timing must be set before comp In and Out points');
assert.match(script, /app\.project\.save\(projectFile\)/, 'running the builder must save a native AEP file');
assert.match(script, /"projectFileName":"Animatic & Cut\.aep"/);
assert.match(script, /"mediaFolderName":"Animatic & Cut_Media"/);
assert.match(script, /"content":"Title &\\nSubtitle"/, 'multiline text must be safely embedded in JSX');
assert.ok(script.includes('project created:\\n" + projectFile.fsName'), 'success alerts must keep their newline escaped inside the JSX string');
assert.ok(script.includes('export failed:\\n" + error.toString()'), 'error alerts must keep their newline escaped inside the JSX string');
assert.ok(!script.includes('project created:\n" + projectFile.fsName'), 'generated JSX must not contain a literal newline inside the success string');
assert.ok(!script.includes('export failed:\n" + error.toString()'), 'generated JSX must not contain a literal newline inside the error string');
assert.doesNotThrow(() => new Function(script.replace(/^#target aftereffects\s*/, '')), 'the emitted JSX body must be syntactically valid JavaScript');
assert.doesNotMatch(script, /<xmeml/, 'After Effects output must not reuse Premiere XML');

console.log('animatics After Effects export tests passed');
