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
import {
  buildPremiereTimeline,
  createPremiereXml,
  premiereFrame,
  safePremiereAssetName,
} from './animatics-premiere-export.mjs';
import {
  AFTER_EFFECTS_MAX_SECONDS,
  buildAfterEffectsProject,
  createAfterEffectsScript,
} from './animatics-after-effects-export.mjs';
import {
  boardTransformAssetKey,
  effectiveFramingScale,
  framingScaleFromEffective,
  normalizeBoardTransform,
  visualSourceGeometry,
} from './animatics-visual-transform.mjs';
import {
  MAX_AUDIO_DB,
  MAX_AUDIO_GAIN,
  MIN_AUDIO_DB,
  audioEnvelopePoints,
  audioFadeGainAt,
  audioWaveformDisplayPeak,
  dbToGain,
  gainToDb,
  normalizedAudioFades,
} from './animatics-audio-model.mjs';

const MAX_VIDEO_TRACKS = 8;
const MAX_AUDIO_TRACKS = 5;
const DEFAULT_SHOT_SECONDS = 3;
const DEFAULT_SEQUENCE_SECONDS = 30;
const MIN_SHOT_SECONDS = 1 / 60;
const MAX_SEQUENCE_SECONDS = 24 * 60 * 60;
const SAFE_INITIAL_TIMELINE_PIXELS = 60000;
const MIN_TIMELINE_ZOOM = .001;
const MAX_TIMELINE_ZOOM = 320;
const HISTORY_LIMIT = 100;
const DEFAULT_TRACK_HEIGHT = 44;
const MIN_TRACK_HEIGHT = 24;
const MAX_TRACK_HEIGHT = 180;
const TRACK_LABEL_WIDTH = 216;
const DEFAULT_INSPECTOR_WIDTH = 278;
const MIN_INSPECTOR_WIDTH = 236;
const MAX_INSPECTOR_WIDTH = 520;
const MIN_VIEWER_WIDTH = 420;
const DRAW_WIDTH_MIN = 1;
const DRAW_WIDTH_MAX = 48;
const DRAW_WIDTH_PRESETS = [1,2,4,6,8,12,16,24,32,48];
const DRAW_BRUSHES = {
  pen:{widthMul:1,alpha:1,shadowMul:0,cap:'round'},
  soft:{widthMul:1.25,alpha:.88,shadowMul:.75,cap:'round'},
  marker:{widthMul:1.45,alpha:.42,shadowMul:0,cap:'round'},
  pencil:{widthMul:.72,alpha:.62,shadowMul:.12,cap:'round'},
};
const DRAW_COLOR_PRESETS=['#000000','#ffffff','#f0f2f6','#ff6b6b','#ff9f6b','#ffd166','#95e879','#5aa2ff','#7dd3fc','#c084fc','#f472b6','#8b8f9a'];
const TEXT_FONT_FAMILIES=['Segoe UI','Arial','Helvetica','Times New Roman','Georgia','Courier New','Verdana','Trebuchet MS','Impact','Comic Sans MS'];
const DEFAULT_TEXT_FONT_FAMILY='Segoe UI';
const TEXT_COORDINATE_WIDTH=1280;
const TEXT_DESIGN_SHORT_EDGE=1080;
const normalizeTextFontFamily=value=>{const family=String(value??'').trim();return TEXT_FONT_FAMILIES.includes(family)?family:DEFAULT_TEXT_FONT_FAMILY;};
const normalizeTextAlign=value=>['left','center','right'].includes(value)?value:'center';
const textCanvasFont=(text,size)=>`${text?.italic===true?'italic ':''}${text?.bold===true?700:400} ${size}px "${normalizeTextFontFamily(text?.fontFamily)}", sans-serif`;
const ASPECT_RATIOS = {
  '16:9': [16, 9],
  '4:3': [4, 3],
  '5:4': [5, 4],
  '9:16': [9, 16],
  '21:9': [21, 9],
};

const uid = () => crypto.randomUUID?.() || `an-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const finiteOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const esc = value => String(value ?? '').replace(/[&<>\"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
function normalizeDrawingStroke(stroke){
  const tool=stroke?.tool==='eraser'?'eraser':'pen',brush=DRAW_BRUSHES[stroke?.brush]?stroke.brush:'pen',color=/^#[0-9a-f]{6}$/i.test(stroke?.color)?stroke.color:'#ff5c5c',width=clamp(Number(stroke?.width)||6,DRAW_WIDTH_MIN,DRAW_WIDTH_MAX),points=(Array.isArray(stroke?.points)?stroke.points:[]).map(point=>({x:clamp(Number(point?.x)||0,0,1),y:clamp(Number(point?.y)||0,0,1)}));
  return {tool,brush,color,width,points};
}

const drawingOverlayCache=new Map();
function drawingFingerprint(strokes=[]){return strokes.map(stroke=>`${stroke.tool||'pen'}:${stroke.brush||'pen'}:${stroke.color||''}:${stroke.width||6}:${(stroke.points||[]).map(point=>`${Number(point?.x)||0},${Number(point?.y)||0}`).join(';')}`).join('|');}
function drawingCacheKey(clip,width,height){return `${clip.id}:${Math.max(1,Math.round(width))}x${Math.max(1,Math.round(height))}`;}
function rememberDrawingOverlay(clip,canvas){const key=drawingCacheKey(clip,canvas.width,canvas.height);drawingOverlayCache.delete(key);drawingOverlayCache.set(key,{canvas,fingerprint:drawingFingerprint(clip.strokes||[])});while(drawingOverlayCache.size>16)drawingOverlayCache.delete(drawingOverlayCache.keys().next().value);return canvas;}
function configureDrawingStroke(g,raw,width,{opaquePen=false}={}){const stroke=normalizeDrawingStroke(raw),brush=DRAW_BRUSHES[stroke.brush]||DRAW_BRUSHES.pen,eraser=stroke.tool==='eraser',lineWidth=stroke.width*(width/1280)*(eraser?1:brush.widthMul);g.lineWidth=Math.max(.5,lineWidth);g.lineCap=eraser?'round':brush.cap;g.lineJoin='round';g.globalCompositeOperation=eraser?'destination-out':'source-over';g.globalAlpha=eraser||opaquePen?1:brush.alpha;g.strokeStyle=eraser?'#000':stroke.color;g.shadowBlur=!eraser&&brush.shadowMul?lineWidth*brush.shadowMul:0;g.shadowColor=!eraser?stroke.color:'transparent';return {stroke,brush,eraser};}
function drawDrawingSegment(g,raw,from,to,width,height,options){g.save();configureDrawingStroke(g,raw,width,options);g.beginPath();g.moveTo(from.x*width,from.y*height);const same=from.x===to.x&&from.y===to.y;g.lineTo(to.x*width+(same?.01:0),to.y*height+(same?.01:0));g.stroke();g.restore();}
function drawingOverlayForClip(clip,width,height){
  const w=Math.max(1,Math.round(width)),h=Math.max(1,Math.round(height)),key=drawingCacheKey(clip,w,h),strokes=clip.strokes||[],fingerprint=drawingFingerprint(strokes),cached=drawingOverlayCache.get(key);if(cached?.fingerprint===fingerprint){drawingOverlayCache.delete(key);drawingOverlayCache.set(key,cached);return cached.canvas;}
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const g=canvas.getContext('2d');
  for(const raw of strokes){const stroke=normalizeDrawingStroke(raw);if(!stroke.points.length)continue;g.save();configureDrawingStroke(g,stroke,w);g.beginPath();stroke.points.forEach((point,index)=>{const x=point.x*w,y=point.y*h;if(index)g.lineTo(x,y);else{g.moveTo(x,y);g.lineTo(x+.01,y+.01);}});g.stroke();g.restore();
  }
  return rememberDrawingOverlay(clip,canvas);
}
function drawClipDrawings(targetCtx,clip,width,height){if(!clip?.strokes?.length)return;targetCtx.drawImage(drawingOverlayForClip(clip,width,height),0,0,width,height);}
function timecode(seconds, fps) {
  const totalFrames = Math.max(0, Math.round(seconds * fps));
  const ff = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  return [hh, mm, ss, ff].map(v => String(v).padStart(2, '0')).join(':');
}

export function parseSequenceTimecode(value, fps = 30) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return NaN;
  const shorthand = text.match(/^(\d+(?:\.\d+)?)\s*([hms])$/);
  if (shorthand) return Number(shorthand[1]) * ({ h:3600, m:60, s:1 })[shorthand[2]];
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 4 || parts.some(part => !/^\d+$/.test(part))) return NaN;
  const values = parts.map(Number);
  let hours=0,minutes=0,seconds=0,frames=0;
  if (values.length===4) [hours,minutes,seconds,frames]=values;
  else if (values.length===3) [hours,minutes,seconds]=values;
  else [minutes,seconds]=values;
  if (minutes>=60 || seconds>=60 || frames>=fps) return NaN;
  return hours*3600+minutes*60+seconds+frames/fps;
}

export function automaticTimelineDuration(contentEnd, minimumSeconds = DEFAULT_SEQUENCE_SECONDS) {
  return Math.max(Math.max(0,Number(minimumSeconds)||0),Math.max(0,Number(contentEnd)||0));
}

export function snappedTextRotation(value, shiftKey = false) {
  const rotation=Number.isFinite(Number(value))?Number(value):0;
  return Math.max(-180,Math.min(180,shiftKey?Math.round(rotation/15)*15:Math.round(rotation)));
}

export function timelineRulerStep(totalSeconds, pixelsPerSecond, maxTicks = 900, minimumLabelPixels = 84) {
  const minimum = Math.max(minimumLabelPixels/Math.max(.001,pixelsPerSecond),Math.max(0,totalSeconds)/maxTicks);
  const steps = [1/60,1/30,1/24,.1,.25,.5,1,2,5,10,15,30,60,120,300,600,900,1800,3600,7200,14400];
  return steps.find(step => step >= minimum) || Math.ceil(minimum/3600)*3600;
}

export function timelineRulerTicks(totalSeconds, pixelsPerSecond, maxTicks = 900, minimumLabelPixels = 84) {
  const total=Math.max(0,Number(totalSeconds)||0),px=Math.max(.001,Number(pixelsPerSecond)||0);
  if(total<=0)return [0];
  const step=timelineRulerStep(total,px,maxTicks,minimumLabelPixels),count=Math.floor(total/step+1e-8),ticks=[];
  for(let index=0;index<=count;index++)ticks.push(index*step);
  const last=ticks.at(-1)??0;
  if(total-last>1e-8){
    if((total-last)*px>=minimumLabelPixels)ticks.push(total);
    else if(ticks.length>1&&(total-ticks.at(-2))*px>=minimumLabelPixels)ticks[ticks.length-1]=total;
  }
  return ticks;
}

function sequenceDimensions(shortEdge, aspect = '16:9') {
  const [rw, rh] = ASPECT_RATIOS[aspect] || ASPECT_RATIOS['16:9'];
  const portrait = rw < rh;
  const width = portrait ? shortEdge : shortEdge * rw / rh;
  const height = portrait ? shortEdge * rh / rw : shortEdge;
  return {
    width: Math.max(2, Math.round(width / 2) * 2),
    height: Math.max(2, Math.round(height / 2) * 2),
  };
}

function css() {
  return `
  body.animatics-open { overflow:hidden; }
  body.animatics-open #toolbar, body.animatics-open #selbar, body.animatics-open #empty,
  body.animatics-open #status, body.animatics-open #board,
  body.animatics-open #drawPanelWrap, body.animatics-open #addPanelWrap { visibility:hidden !important; pointer-events:none !important; }
  #animaticsWorkspace { --an-timeline-h:286px; --an-inspector-w:${DEFAULT_INSPECTOR_WIDTH}px; --an-track-label-w:${TRACK_LABEL_WIDTH}px; position:fixed; inset:0; z-index:80; display:none; color:#eef0f5; color-scheme:dark; background:#0c0d10; font:12px/1.35 "Segoe UI",sans-serif; user-select:none; }
  #animaticsWorkspace.open { display:grid; grid-template-rows:52px minmax(0,1fr) var(--an-timeline-h); }
  .an-top { display:flex; align-items:center; gap:8px; min-width:0; padding:0 14px; border-bottom:1px solid #272a33; background:#15171d; -webkit-app-region:no-drag; }
  .an-brand { display:flex; align-items:center; gap:8px; min-width:190px; }
  .an-back,.an-btn,.an-icon,.an-track-add,.an-tab { border:1px solid transparent; color:#bfc4d0; background:transparent; cursor:pointer; }
  .an-back,.an-icon { width:34px; height:34px; border-radius:9px; display:grid; place-items:center; }
  .an-back:hover,.an-icon:hover,.an-btn:hover,.an-track-add:hover,.an-tab:hover { color:#fff; background:#242730; }
  .an-back svg,.an-icon svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .an-brand-lockup { display:grid; grid-template-columns:27px auto; grid-template-rows:14px 12px; column-gap:8px; align-items:center; min-width:0; }
  .an-brand-mark { grid-row:1/3; width:27px; height:27px; display:block; filter:drop-shadow(0 3px 8px rgba(0,0,0,.35)); }
  .an-brand-name { align-self:end; color:#f6f8fb; font-size:11px; font-weight:700; line-height:1; letter-spacing:.01em; white-space:nowrap; }
  .an-title { align-self:start; color:#78b7ff; font-size:9px; font-weight:650; line-height:1; letter-spacing:.13em; text-transform:uppercase; white-space:nowrap; }
  .an-transport { display:flex; align-items:center; justify-content:center; gap:4px; }
  .an-transport .an-icon { width:31px; height:31px; }
  .an-play { width:36px; height:36px; border-radius:50%; background:#f0f2f7; color:#101217; border:0; display:grid; place-items:center; cursor:pointer; }
  .an-play:hover { background:#fff; transform:scale(1.03); }
  .an-play svg { width:17px; height:17px; fill:currentColor; }
  .an-time { min-width:154px; padding:0 10px; display:flex; align-items:center; justify-content:center; text-align:center; color:#e9ebf1; font:600 11px/1.2 ui-monospace,Consolas,monospace; white-space:nowrap; }
  .an-top-actions { display:flex; align-items:center; gap:7px; margin-left:auto; justify-content:flex-end; }
  .an-btn { height:34px; padding:0 12px; border-radius:9px; font-weight:600; }
  .an-btn.primary { color:#0c1118; background:#67aaff; }
  .an-btn.primary:hover { color:#081018; background:#86bbff; }
  .an-stage-row { display:grid; grid-template-columns:0 0 minmax(0,1fr) 0; min-height:0; overflow:hidden; background:#0d0f13; transition:grid-template-columns .22s ease; }
  #animaticsWorkspace.panel-open .an-stage-row { grid-template-columns:var(--an-inspector-w) 6px minmax(0,1fr) 0; }
  #animaticsWorkspace.inspector-resizing .an-stage-row { transition:none; }
  .an-side { min-width:0; overflow:hidden; border-right:1px solid #292c35; background:#15171c; }
  .an-side-inner { width:100%; height:100%; display:flex; flex-direction:column; }
  .an-side-resizer { position:relative; z-index:16; min-width:0; opacity:0; pointer-events:none; cursor:col-resize; touch-action:none; background:#101217; transition:opacity .15s ease,background .15s ease; }
  #animaticsWorkspace.panel-open .an-side-resizer { opacity:1; pointer-events:auto; }
  .an-side-resizer::after { content:""; position:absolute; top:0; bottom:0; left:2px; width:2px; background:#2d313b; transition:background .12s ease,box-shadow .12s ease; }
  .an-side-resizer:hover::after,.an-side-resizer.dragging::after,.an-side-resizer:focus-visible::after { background:#69aaff; box-shadow:0 0 8px rgba(105,170,255,.55); }
  .an-side-resizer:focus-visible { outline:none; }
  .an-tabs { display:grid; grid-template-columns:repeat(5,1fr); padding:9px; gap:3px; border-bottom:1px solid #282b34; }
  .an-tab { height:33px; border-radius:8px; font-size:11px; }
  .an-tab.on { color:#fff; background:#282c36; }
  .an-panel { display:none; padding:16px; overflow:auto; }
  .an-panel.on { display:block; }
  .an-section-title { margin:0 0 12px; color:#f1f2f6; font-size:12px; font-weight:650; }
  .an-field { display:grid; gap:6px; margin-bottom:13px; color:#9299a8; }
  .an-field input,.an-field textarea,.an-field select { width:100%; box-sizing:border-box; border:1px solid #333743; background-color:#101217; color:#edf0f5; border-radius:8px; padding:8px 9px; outline:none; font:inherit; }
  .an-field input[type="number"] { appearance:textfield; -moz-appearance:textfield; }
  .an-field input[type="number"]::-webkit-inner-spin-button,.an-field input[type="number"]::-webkit-outer-spin-button { appearance:none; margin:0; }
  .an-field select,.an-view-settings select { appearance:none; padding-right:28px; background-image:linear-gradient(45deg,transparent 50%,#858d9b 50%),linear-gradient(135deg,#858d9b 50%,transparent 50%); background-position:calc(100% - 13px) 50%,calc(100% - 9px) 50%; background-size:4px 4px,4px 4px; background-repeat:no-repeat; }
  #animaticsWorkspace input[type="range"] { appearance:none; height:16px; background:transparent; cursor:pointer; }
  #animaticsWorkspace input[type="range"]::-webkit-slider-runnable-track { height:4px; border-radius:99px; background:#343a47; }
  #animaticsWorkspace input[type="range"]::-webkit-slider-thumb { appearance:none; width:13px; height:13px; margin-top:-4.5px; border:2px solid #151922; border-radius:50%; background:#68aaff; box-shadow:0 0 0 1px #75b2ff; }
  .an-field textarea { min-height:78px; resize:vertical; }
  .an-field input:focus,.an-field textarea:focus,.an-field select:focus { border-color:#5aa2ff; }
  .an-fade-controls { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px; }
  .an-fade-card { min-width:0; padding:8px; border:1px solid #2f333d; border-radius:8px; background:#12141a; }
  .an-fade-card h4 { margin:0 0 7px; color:#dbe4ef; font-size:11px; }
  .an-fade-custom { display:none; margin-top:6px; }
  .an-fade-custom.show { display:block; }
  .an-split { display:grid; grid-template-columns:1fr 1fr; gap:9px; }
  .an-tool-btn { width:100%; height:35px; margin-bottom:8px; border:1px solid #333743; border-radius:9px; background:#20232b; color:#d9dde6; cursor:pointer; }
  .an-tool-btn:hover,.an-tool-btn.on { border-color:#5aa2ff; color:#fff; background:#26384f; }
  .an-draw-tool-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px; }
  .an-draw-tool { min-width:0; height:38px; padding:0 9px; border:1px solid #333743; border-radius:9px; display:flex; align-items:center; gap:7px; color:#cbd1dc; background:#1d2028; cursor:pointer; }
  .an-draw-tool:hover,.an-draw-tool.on { border-color:#5aa2ff; color:#fff; background:#26384f; }
  .an-draw-tool svg { width:16px; height:16px; flex:0 0 16px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
  .an-draw-tool span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .an-draw-tool kbd,.an-draw-size-row kbd { margin-left:auto; padding:1px 5px; border:1px solid #3a3f4c; border-radius:4px; color:#8f98a8; background:#14161b; font:9px ui-monospace,Consolas,monospace; }
  .an-draw-brushes { display:none; grid-template-columns:repeat(4,minmax(0,1fr)); gap:5px; margin:-1px 0 10px; padding:6px; border:1px solid #2f333d; border-radius:9px; background:#12141a; }
  .an-draw-brushes.open { display:grid; }
  .an-draw-brush { min-width:0; height:48px; padding:4px 2px; border:0; border-radius:7px; display:grid; place-items:center; gap:2px; color:#939cab; background:transparent; cursor:pointer; font:9px "Segoe UI",sans-serif; }
  .an-draw-brush:hover,.an-draw-brush.on { color:#fff; background:#27384e; }
  .an-draw-brush svg { width:17px; height:17px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
  .an-draw-color-btn { width:100%; height:36px; margin-bottom:8px; padding:0 10px; border:1px solid #333743; border-radius:9px; display:flex; align-items:center; gap:9px; color:#cbd1dc; background:#1d2028; cursor:pointer; }
  .an-draw-color-btn:hover,.an-draw-color-btn.open { border-color:#5aa2ff; color:#fff; }
  .an-draw-color-swatch { width:18px; height:18px; flex:0 0 18px; border:1px solid rgba(255,255,255,.28); border-radius:6px; box-shadow:inset 0 0 0 1px rgba(0,0,0,.25); }
  .an-draw-color-pop { display:none; margin:-1px 0 10px; padding:10px; border:1px solid #333743; border-radius:10px; background:#171920; }
  .an-draw-color-pop.open { display:block; }
  .an-draw-cp-sv { position:relative; height:118px; overflow:hidden; border-radius:8px; cursor:crosshair; touch-action:none; background:#f00; box-shadow:inset 0 0 0 1px #333743; }
  .an-draw-cp-white,.an-draw-cp-black { position:absolute; inset:0; }
  .an-draw-cp-white { background:linear-gradient(to right,#fff,transparent); }
  .an-draw-cp-black { background:linear-gradient(to top,#000,transparent); }
  .an-draw-cp-dot { position:absolute; width:12px; height:12px; margin:-6px 0 0 -6px; border:2px solid #fff; border-radius:50%; box-shadow:0 0 0 1px rgba(0,0,0,.6); pointer-events:none; }
  #animaticsWorkspace .an-draw-cp-hue { width:100%; height:14px; margin-top:9px; background:linear-gradient(to right,#f00 0%,#ff0 17%,#0f0 33%,#0ff 50%,#00f 67%,#f0f 83%,#f00 100%); }
  #animaticsWorkspace .an-draw-cp-hue::-webkit-slider-runnable-track { height:12px; background:transparent; }
  #animaticsWorkspace .an-draw-cp-hue::-webkit-slider-thumb { margin-top:-.5px; background:#fff; }
  .an-draw-cp-row { display:grid; grid-template-columns:28px minmax(0,1fr); align-items:center; gap:8px; margin-top:9px; }
  .an-draw-cp-preview { width:28px; height:28px; border:1px solid #3a3f4c; border-radius:8px; }
  .an-draw-cp-hex { width:100%; height:29px; box-sizing:border-box; padding:0 8px; border:1px solid #333743; border-radius:8px; outline:none; color:#edf0f5; background:#101217; font:11px ui-monospace,Consolas,monospace; text-transform:uppercase; }
  .an-draw-cp-hex:focus { border-color:#5aa2ff; }
  .an-draw-cp-presets { display:grid; grid-template-columns:repeat(6,1fr); gap:5px; margin-top:9px; }
  .an-draw-cp-preset { aspect-ratio:1; padding:0; border:0; border-radius:5px; cursor:pointer; box-shadow:inset 0 0 0 1px rgba(255,255,255,.16); }
  .an-draw-cp-preset.on { box-shadow:0 0 0 2px #68aaff; }
  .an-text-color-btn { margin-bottom:0; }
  .an-text-color-pop { margin:-5px 0 13px; }
  .an-draw-size-row { display:grid; grid-template-columns:30px 92px 30px; justify-content:start; align-items:center; gap:6px; margin-bottom:9px; }
  .an-draw-size-btn { height:30px; padding:0; border:1px solid #333743; border-radius:7px; color:#dce1ea; background:#20232b; cursor:pointer; font-size:16px; }
  .an-draw-size-btn:hover { border-color:#5aa2ff; color:#fff; }
  .an-draw-size-combo { position:relative; width:92px; height:30px; display:grid; grid-template-columns:minmax(0,1fr) 27px; }
  .an-draw-size-value { min-width:0; width:100%; height:30px; box-sizing:border-box; padding:0 7px; border:1px solid #333743; border-right:0; border-radius:7px 0 0 7px; outline:none; color:#eef2f8; background:#101217; font:600 11px ui-monospace,Consolas,monospace; appearance:textfield; }
  .an-draw-size-value::-webkit-inner-spin-button,.an-draw-size-value::-webkit-outer-spin-button { appearance:none; margin:0; }
  .an-draw-size-value:focus { border-color:#5aa2ff; }
  .an-draw-size-menu-btn { height:30px; padding:0; border:1px solid #333743; border-radius:0 7px 7px 0; display:grid; place-items:center; color:#9099a8; background:#171920; cursor:pointer; }
  .an-draw-size-menu-btn:hover,.an-draw-size-menu-btn.open { border-color:#5aa2ff; color:#fff; background:#222b38; }
  .an-draw-size-menu-btn svg { width:12px; height:12px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
  .an-draw-size-menu { position:fixed; z-index:48; left:0; top:0; width:92px; max-height:min(286px,calc(100vh - 12px)); display:none; overflow:auto; padding:4px; box-sizing:border-box; border:1px solid #343945; border-radius:8px; background:#15171d; box-shadow:0 10px 28px rgba(0,0,0,.45); }
  .an-draw-size-menu.open { display:grid; }
  .an-draw-size-option { height:27px; padding:0 8px; border:0; border-radius:5px; color:#bbc2ce; background:transparent; cursor:pointer; text-align:left; font:11px ui-monospace,Consolas,monospace; }
  .an-draw-size-option:hover,.an-draw-size-option.on { color:#fff; background:#27384e; }
  .an-draw-size-preview { position:absolute; z-index:18; left:0; top:0; width:8px; height:8px; border:1px solid rgba(255,255,255,.96); border-radius:50%; opacity:0; pointer-events:none; translate:-50% -50%; scale:.88; box-shadow:0 0 0 1px rgba(7,9,13,.9),0 2px 10px rgba(0,0,0,.32); transition:width .085s ease,height .085s ease,opacity .12s ease,scale .12s ease; }
  .an-draw-size-preview.show { opacity:1; scale:1; }
  .an-stage { min-width:0; min-height:0; position:relative; display:grid; place-items:center; padding:18px 38px 12px; overflow:hidden; }
  .an-viewer-wrap { position:relative; width:100%; height:100%; min-height:0; display:grid; grid-template-rows:minmax(0,1fr) 44px; gap:8px; }
  .an-viewer-viewport { min-width:0; min-height:0; position:relative; display:grid; place-items:center; overflow:hidden; }
  .an-viewer-shell { z-index:1; min-height:0; position:relative; display:grid; place-items:center; justify-self:center; align-self:center; overflow:hidden; border-radius:7px; background:#050607; box-shadow:0 18px 60px rgba(0,0,0,.48); aspect-ratio:16/9; transform:translate3d(var(--an-preview-pan-x,0px),var(--an-preview-pan-y,0px),0) scale(var(--an-preview-zoom,1)); transform-origin:center; will-change:transform; }
  .an-viewer-shell.preview-zoomed { box-shadow:0 22px 72px rgba(0,0,0,.62); }
  .an-viewer-shell.preview-panning { cursor:grabbing!important; }
  #anViewer { display:block; width:100%; height:100%; background:#000; touch-action:none; }
  .an-inline-text { position:absolute; z-index:12; display:none; min-width:24px; min-height:24px; box-sizing:border-box; padding:0 2px; border:1px solid #69aaff; border-radius:1px; outline:none; resize:none; overflow:hidden; color:#fff; background:transparent; box-shadow:none; text-align:center; font:400 24px "Segoe UI",sans-serif; line-height:1.2; transform-origin:center; user-select:text; }
  .an-inline-text.open { display:block; }
  .an-safe-guides { position:absolute; z-index:9; inset:0; display:none; pointer-events:none; }
  .an-safe-guides.show { display:block; }
  .an-safe-guide { position:absolute; box-sizing:border-box; border:1px dashed rgba(255,255,255,.72); filter:drop-shadow(0 1px 1px rgba(0,0,0,.72)); }
  .an-safe-guide.action { inset:10%; }
  .an-safe-guide.title { inset:20%; border-color:rgba(255,255,255,.9); }
  .an-safe-center { position:absolute; left:50%; top:50%; width:28px; height:28px; translate:-50% -50%; filter:drop-shadow(0 1px 1px rgba(0,0,0,.72)); }
  .an-safe-center::before,.an-safe-center::after { content:""; position:absolute; left:50%; top:50%; background:rgba(255,255,255,.9); translate:-50% -50%; }
  .an-safe-center::before { width:28px; height:1px; }
  .an-safe-center::after { width:1px; height:28px; }
  .an-transport .an-icon.on { color:#cce5ff; background:#28496d; box-shadow:inset 0 0 0 1px #5a9de7; }
  .an-viewer-shell.framing { outline:2px solid #67aaff; outline-offset:3px; }
  .an-viewer-shell.framing::after { content:"Reframe · drag to position · wheel to scale · double-click to finish"; position:absolute; left:50%; bottom:12px; translate:-50% 0; padding:6px 10px; border-radius:7px; background:rgba(7,10,15,.78); color:#e7f1ff; font-size:10px; white-space:nowrap; pointer-events:none; }
  .an-empty-stage { position:absolute; inset:0; display:grid; place-items:center; color:#727987; text-align:center; pointer-events:none; }
  .an-empty-stage.hide { display:none; }
  .an-stage-foot { position:relative; z-index:20; display:grid; grid-template-columns:minmax(120px,1fr) auto minmax(120px,1fr); align-items:center; gap:10px; color:#858c9a; background:transparent; }
  .an-stage-foot b { color:#d9dde5; font-weight:600; }
  .an-footer-left { min-width:0; width:100%; display:flex; align-items:center; gap:5px; justify-self:start; overflow:hidden; }
  .an-shot-cluster,.an-time,.an-transport { min-height:36px; border:1px solid rgba(255,255,255,.075); background:rgba(20,23,29,.72); box-shadow:0 8px 24px rgba(0,0,0,.2),inset 0 1px 0 rgba(255,255,255,.025); backdrop-filter:blur(12px); }
  .an-shot-cluster { min-width:0; flex:0 1 auto; max-width:min(38vw,330px); padding:0 10px; border-radius:10px; display:flex; align-items:center; overflow:hidden; }
  .an-time { width:164px; min-width:164px; flex:0 0 164px; box-sizing:border-box; border-radius:10px; }
  .an-transport { min-width:126px; padding:0 7px; border-radius:12px; }
  .an-view-settings { position:relative; z-index:32; justify-self:end; display:flex; align-items:center; gap:5px; }
  .an-view-select { position:relative; width:100%; min-width:0; }
  .an-view-select.compact { width:auto; min-width:74px; }
  .an-view-select.quality { min-width:110px; }
  .an-view-select-native { position:absolute!important; width:1px!important; height:1px!important; opacity:0!important; pointer-events:none!important; overflow:hidden!important; }
  .an-view-select-button { width:100%; height:34px; padding:0 9px 0 10px; display:flex; align-items:center; justify-content:space-between; gap:9px; border:1px solid #30343e; border-radius:9px; color:#c5cbd5; background:#17191f; box-shadow:0 8px 24px rgba(0,0,0,.18),inset 0 1px 0 rgba(255,255,255,.025); font:600 11px/1.3 "Segoe UI",sans-serif; text-align:left; cursor:pointer; }
  .an-view-select-button span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .an-view-select-button:hover,.an-view-select.open .an-view-select-button { border-color:#4e5666; color:#fff; background:#1d2129; }
  .an-view-select-button:disabled { opacity:.46; cursor:not-allowed; }
  .an-view-select-button:focus-visible { outline:none; border-color:#5f9fe8; box-shadow:0 0 0 3px rgba(95,159,232,.16); }
  .an-view-select-button svg { width:12px; height:12px; flex:0 0 12px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; transition:transform .15s ease; }
  .an-view-select.open .an-view-select-button svg { transform:rotate(180deg); }
  .an-view-select-menu { position:fixed; z-index:96; left:0; top:0; min-width:74px; max-width:min(320px,calc(100vw - 16px)); max-height:min(260px,calc(100vh - 16px)); display:none; overflow:auto; box-sizing:border-box; flex-direction:column; gap:2px; padding:5px; border:1px solid #343945; border-radius:10px; color:#bbc3d0; background:#171920; box-shadow:0 16px 42px rgba(0,0,0,.52); backdrop-filter:blur(14px); }
  .an-view-select-menu.open { display:flex; }
  .an-view-select-option { min-width:100%; height:30px; padding:0 28px 0 9px; position:relative; border:0; border-radius:7px; color:inherit; background:transparent; text-align:left; white-space:nowrap; font:11px "Segoe UI",sans-serif; cursor:pointer; }
  .an-view-select-option:hover,.an-view-select-option:focus-visible { outline:none; color:#fff; background:#252b36; }
  .an-view-select-option.on { color:#e9f4ff; background:#24364c; }
  .an-view-select-option.on::after { content:"✓"; position:absolute; right:9px; top:50%; translate:0 -50%; color:#73b2ff; font-weight:700; }
  #anShotLabel { min-width:0; display:flex; align-items:center; overflow:hidden; white-space:nowrap; }
  .an-shot-name { min-width:0; max-width:min(20vw,190px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .an-shot-meta { flex:0 0 auto; color:#9299a7; white-space:nowrap; }
  .an-preview-zoom-hud { position:absolute; z-index:28; left:50%; bottom:53px; translate:-50% 6px; min-height:34px; padding:4px; display:flex; align-items:center; gap:3px; border:1px solid rgba(255,255,255,.1); border-radius:11px; color:#dce3ed; background:rgba(17,20,26,.86); box-shadow:0 12px 34px rgba(0,0,0,.38),inset 0 1px 0 rgba(255,255,255,.035); backdrop-filter:blur(14px); opacity:0; visibility:hidden; pointer-events:none; transition:opacity .16s ease,translate .16s ease,visibility 0s linear .16s; }
  .an-preview-zoom-hud.show { opacity:1; visibility:visible; pointer-events:auto; translate:-50% 0; transition-delay:0s; }
  .an-preview-zoom-value { min-width:48px; padding:0 8px; color:#f2f5f9; text-align:center; font:650 10px/26px ui-monospace,Consolas,monospace; }
  .an-preview-zoom-action { height:26px; padding:0 8px; border:0; border-radius:7px; color:#aeb7c5; background:transparent; font:600 10px "Segoe UI",sans-serif; cursor:pointer; }
  .an-preview-zoom-action:hover { color:#fff; background:rgba(255,255,255,.09); }
  .an-preview-zoom-action.on { color:#dceeff; background:#28496d; box-shadow:inset 0 0 0 1px #5a9de7; }
  .an-frame-actions { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; margin-bottom:10px; }
  .an-frame-actions .an-tool-btn { margin:0; }
  .an-scale-row { display:grid; grid-template-columns:1fr 46px; align-items:center; gap:8px; margin-bottom:13px; }
  .an-scale-row input { width:100%; accent-color:#67aaff; }
  .an-scale-row output { color:#dce8f8; text-align:right; font:11px ui-monospace,Consolas,monospace; }
  .an-timeline { min-height:0; position:relative; display:grid; grid-template-rows:42px minmax(0,1fr); border-top:1px solid #292c34; background:#121419; }
  .an-timeline-resizer { position:absolute; z-index:35; top:-5px; left:0; right:0; height:10px; cursor:row-resize; touch-action:none; }
  .an-timeline-resizer::after { content:""; position:absolute; left:50%; top:3px; width:52px; height:3px; translate:-50% 0; border-radius:99px; background:#404653; transition:.15s; }
  .an-timeline-resizer:hover::after,.an-timeline-resizer.dragging::after { width:76px; background:#69aaff; box-shadow:0 0 12px rgba(105,170,255,.45); }
  .an-tl-head { display:flex; align-items:center; gap:8px; padding:0 12px; border-bottom:1px solid #282b33; }
  .an-tl-head .an-icon { width:30px; height:30px; }
  .an-edit-tools { display:flex; align-items:center; gap:3px; padding:3px; border:1px solid #303540; border-radius:8px; background:#0f1116; }
  .an-edit-tool { width:28px; min-width:28px; height:26px; padding:0; border:0; border-radius:6px; display:flex; align-items:center; justify-content:center; background:transparent; color:#8993a2; font:700 10px "Segoe UI",sans-serif; cursor:pointer; }
  .an-edit-tool svg { width:18px; height:18px; flex:0 0 18px; overflow:visible; }
  .an-edit-tool .text-glyph { color:#e5eaf2; font-size:16px; font-weight:600; line-height:1; }
  .an-edit-tool:hover,.an-edit-tool.on { color:#f3f7ff; background:#2a4565; }
  .an-edit-tool:disabled { opacity:.34; cursor:not-allowed; background:transparent; }
  .an-edit-tool.link-active { color:#e7f3ff; background:#2a4565; box-shadow:inset 0 0 0 1px #5a9de7; }
  .an-edit-divider { width:1px; height:17px; margin:0 2px; background:#343946; }
  .an-snap-btn { display:flex!important; align-items:center; gap:4px; width:auto!important; padding:0 8px; }
  .an-snap-btn.on { color:#cce5ff; background:#28496d; box-shadow:inset 0 0 0 1px #5a9de7; }
  #anTlSummary { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; color:#9299a7; }
  .an-zoom { margin-left:auto; display:flex; align-items:center; gap:7px; color:#858c99; }
  .an-zoom input { width:96px; accent-color:#5aa2ff; }
  .an-tl-scroll { overflow:auto; position:relative; }
  .an-panel,.an-tl-scroll { scrollbar-color:#414754 #15181e; scrollbar-width:thin; }
  .an-panel::-webkit-scrollbar,.an-tl-scroll::-webkit-scrollbar { width:10px; height:10px; }
  .an-panel::-webkit-scrollbar-track,.an-tl-scroll::-webkit-scrollbar-track { background:#15181e; }
  .an-tl-scroll::-webkit-scrollbar-track:horizontal { margin-left:var(--an-track-label-w); }
  .an-panel::-webkit-scrollbar-thumb,.an-tl-scroll::-webkit-scrollbar-thumb { border:2px solid #15181e; border-radius:99px; background:#414754; }
  .an-panel::-webkit-scrollbar-thumb:hover,.an-tl-scroll::-webkit-scrollbar-thumb:hover { background:#566070; }
  .an-tl-grid { min-width:100%; min-height:100%; position:relative; padding-bottom:12px; box-sizing:border-box; }
  .an-ruler-row,.an-track-row { display:grid; grid-template-columns:var(--an-track-label-w) var(--an-lane-width,900px); width:calc(var(--an-track-label-w) + var(--an-lane-width,900px)); }
  .an-ruler-row { height:32px; min-height:32px; position:sticky; top:0; z-index:8; background:#14161b; }
  .an-track-row { position:relative; height:var(--an-track-height,44px); min-height:24px; }
  .an-track-label { position:sticky; left:0; z-index:7; display:flex; align-items:center; gap:5px; min-width:0; min-height:0; padding:0 7px 0 5px; color:#9ca3b0; background:#17191f; border-right:1px solid #2b2e37; border-bottom:1px solid #242730; overflow:hidden; }
  .an-track-label b { color:#dfe2e8; font-size:11px; }
  .an-track-target { min-width:28px; height:24px; padding:0 5px; border:1px solid transparent; border-radius:6px; color:#dfe2e8; background:transparent; font:700 11px "Segoe UI",sans-serif; cursor:pointer; }
  .an-track-target:hover,.an-track-target:focus-visible { color:#f3f8ff; background:#293547; outline:none; }
  .an-track-target:disabled { opacity:.45; cursor:not-allowed; }
  .an-track-target.on { border-color:#5a9de7; color:#eaf5ff; background:#28496d; box-shadow:inset 0 0 0 1px rgba(130,190,255,.2),0 0 9px rgba(74,145,226,.2); }
  .an-track-label>span { min-width:28px; color:#636a77; font-size:10px; }
  .an-track-actions { margin-left:auto; display:flex; flex:0 0 auto; align-items:center; gap:2px; }
  .an-track-grip { width:20px; height:24px; padding:0; border:0; display:grid; place-items:center; border-radius:5px; color:#717987; background:transparent; cursor:grab; touch-action:none; }
  .an-track-grip:hover,.an-track-grip:focus-visible { color:#d8e8fb; background:#293547; outline:none; }
  .an-track-grip:active { cursor:grabbing; }
  .an-track-grip svg { width:12px; height:14px; fill:currentColor; }
  .an-time-mode { height:24px; padding:0 6px; border:0; border-radius:5px; color:#8f98a8; background:transparent; font:700 9px ui-monospace,Consolas,monospace; letter-spacing:.04em; cursor:pointer; }
  .an-time-mode:hover,.an-time-mode:focus-visible { color:#dcecff; background:#293547; outline:none; }
  .an-track-remove { width:21px; height:21px; margin-left:0; padding:0; border:1px solid transparent; border-radius:5px; display:grid; place-items:center; opacity:.68; color:#8f98a8; background:transparent; cursor:pointer; transition:.12s; }
  .an-track-label:hover .an-track-remove,.an-track-remove:focus-visible { opacity:1; }
  .an-track-remove:hover { border-color:#71434b; color:#ffd9df; background:#45272d; }
  .an-track-remove svg { width:11px; height:11px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; }
  .an-track-visibility { width:23px; height:23px; flex:0 0 auto; padding:0; border:1px solid transparent; border-radius:5px; display:grid; place-items:center; color:#b7c5d8; background:transparent; cursor:pointer; transition:.12s; }
  .an-track-visibility:hover,.an-track-visibility:focus-visible { color:#e9f4ff; background:#293547; outline:none; }
  .an-track-visibility.off { color:#68717f; background:#202329; }
  .an-track-visibility svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
  .an-track-toggle { width:23px; height:23px; flex:0 0 auto; padding:0; border:1px solid transparent; border-radius:5px; display:grid; place-items:center; color:#9099a8; background:transparent; font:700 10px/1 "Segoe UI",sans-serif; cursor:pointer; transition:.12s; }
  .an-track-toggle:hover,.an-track-toggle:focus-visible { color:#eef6ff; background:#293547; outline:none; }
  .an-track-toggle.on { border-color:#4f82ba; color:#eaf5ff; background:#28496d; box-shadow:inset 0 0 0 1px rgba(130,190,255,.16); }
  .an-track-toggle.mute.on { border-color:#98515a; color:#ffe1e5; background:#5a2b32; }
  .an-track-toggle.solo.on { border-color:#b58d35; color:#fff0b3; background:#59471e; }
  .an-track-toggle svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
  .an-track-lane { position:relative; border-bottom:1px solid #242730; background-image:linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px); background-size:var(--an-second-px,90px) 100%; touch-action:none; }
  .an-track-resize { position:absolute; z-index:12; left:0; right:auto; bottom:-3px; width:var(--an-track-label-w); height:7px; padding:0; border:0; background:transparent; cursor:row-resize; touch-action:none; }
  .an-track-resize::after { content:""; position:absolute; left:8px; right:8px; top:3px; height:1px; background:transparent; }
  .an-track-resize:hover::after,.an-track-resize.dragging::after { background:#6aaaff; box-shadow:0 0 7px rgba(106,170,255,.55); }
  .an-track-row.reorder-source { opacity:.58; }
  .an-track-row.reorder-target::after { content:""; position:absolute; z-index:11; inset:1px 0; border:1px solid #70aff5; background:rgba(77,145,222,.09); pointer-events:none; }
  .an-ruler { position:relative; overflow:hidden; border-bottom:1px solid #30333c; cursor:default; touch-action:none; }
  .an-tick { position:absolute; inset-block:0 auto; width:max-content; padding:7px 0 0 5px; color:#6f7683; font:10px ui-monospace,Consolas,monospace; white-space:nowrap; border-left:1px solid #343741; pointer-events:none; }
  .an-clip { position:absolute; z-index:2; top:3px; bottom:4px; min-width:16px; min-height:14px; border:1px solid #4d77aa; border-radius:6px; overflow:hidden; cursor:pointer; background:#243a55; color:#e7effb; box-shadow:0 2px 8px rgba(0,0,0,.25); transition:opacity .15s ease,transform .15s ease,box-shadow .15s ease; }
  .an-clip:hover,.an-clip.on { border-color:#79b6ff; box-shadow:0 0 0 1px rgba(90,162,255,.3),0 4px 12px rgba(0,0,0,.4); }
  .an-clip.primary { box-shadow:0 0 0 2px rgba(118,190,255,.72),0 4px 14px rgba(0,0,0,.48); }
  .an-clip.clip-disabled,.an-track-row.track-disabled .an-clip { opacity:.38; filter:saturate(.32); border-style:dashed; }
  .an-clip.clip-disabled.on,.an-clip.clip-disabled.primary,.an-track-row.track-disabled .an-clip.on,.an-track-row.track-disabled .an-clip.primary { opacity:.62; }
  .an-track-row.track-disabled .an-track-lane { background-color:rgba(0,0,0,.16); }
  .an-track-row.track-muted .an-clip { opacity:.48; }
  .an-track-row.track-locked .an-clip { filter:saturate(.55); cursor:not-allowed!important; }
  .an-track-row.track-locked .an-track-lane { background-color:rgba(38,45,56,.28); }
  .an-clip.dragging-source { opacity:.28; transform:scale(.975); box-shadow:none; }
  .an-drag-ghost { position:fixed!important; z-index:70; bottom:auto; pointer-events:none; opacity:.8; transform:none; transition:none; box-shadow:0 12px 28px rgba(0,0,0,.48),0 0 0 1px rgba(114,180,255,.5)!important; will-change:left,top; }
  .an-track-lane.an-lane-hover { background-color:rgba(89,156,239,.11); box-shadow:inset 0 0 0 1px rgba(103,170,255,.38); }
  .an-clip img { width:clamp(24px,calc(var(--an-track-height,44px) - 2px),150px); height:100%; object-fit:cover; float:left; margin-right:7px; background:#0d0f13; pointer-events:none; }
  .an-clip-name { position:relative; z-index:2; display:block; max-width:calc(100% - 14px); margin-top:4px; padding-right:15px; box-sizing:border-box; font-size:10px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; text-shadow:0 1px 3px rgba(0,0,0,.9); }
  .an-clip-dur { position:relative; z-index:2; display:block; color:#a9bed7; font-size:9px; text-shadow:0 1px 3px rgba(0,0,0,.9); }
  .an-fade-envelope { position:absolute; z-index:3; inset:1px 2px; width:calc(100% - 4px); height:calc(100% - 2px); overflow:visible; pointer-events:none; }
  .an-fade-envelope polyline { fill:none; stroke:#70afff; stroke-width:1.2; vector-effect:non-scaling-stroke; filter:drop-shadow(0 0 1px rgba(75,151,255,.45)); }
  .an-fade-handle { position:absolute; z-index:9; top:2px; width:9px; height:9px; margin-left:-4.5px; padding:0; border:1px solid #8bc1ff; border-radius:2px; opacity:.32; background:#234a73; box-shadow:0 0 0 1px rgba(5,10,17,.88),0 2px 5px rgba(0,0,0,.38); cursor:ew-resize; touch-action:none; will-change:left; transform:translateZ(0); transition:opacity .1s ease,background .1s ease,border-color .1s ease; }
  .an-audio:hover .an-fade-handle,.an-audio.on .an-fade-handle,.an-fade-handle:focus-visible { opacity:1; }
  .an-fade-handle:hover,.an-fade-handle:active { border-color:#d5e9ff; background:#5799df; }
  .an-track-row.compact .an-clip-name { margin-top:2px; font-size:9px; }
  .an-track-row.compact .an-clip-dur,.an-track-row.compact .an-link-badge { display:none; }
  .an-trim { position:absolute; top:0; right:0; bottom:0; width:8px; cursor:ew-resize; background:linear-gradient(90deg,transparent,rgba(255,255,255,.3)); z-index:3; }
  .an-trim-left { left:0; right:auto; background:linear-gradient(90deg,rgba(255,255,255,.3),transparent); }
  .an-audio { border-color:#497f68; background:#1f493b; color:#e3f8ee; }
  .an-video { border-color:#7b659b; background:#403058; color:#f1e9ff; }
  .an-text-clip { border-color:#9d6b85; background:#593247; color:#ffe9f4; }
  .an-clip.linked-peer { border-color:#d4a9ff; box-shadow:0 0 0 1px rgba(190,137,244,.34),0 4px 12px rgba(0,0,0,.4); }
  .an-link-badge { position:absolute; z-index:4; right:9px; top:3px; width:12px; height:12px; display:grid; place-items:center; border-radius:4px; color:#efe3ff; background:rgba(40,23,58,.82); pointer-events:none; }
  .an-link-badge svg { width:9px; height:9px; fill:none; stroke:currentColor; stroke-width:2.2; stroke-linecap:round; }
  .an-gap { position:absolute; z-index:1; top:5px; bottom:5px; min-width:2px; box-sizing:border-box; padding:0; overflow:hidden; border:1px solid transparent; border-radius:5px; color:#ffdce0; background:transparent; cursor:pointer; outline:none; }
  .an-gap:hover,.an-gap:focus-visible { border-color:#9f4652; background:#632a32; }
  .an-gap.on { border-color:#ef6977; background:#8a303a; box-shadow:0 0 0 1px rgba(255,108,122,.25),0 4px 13px rgba(0,0,0,.32); }
  .an-gap span { display:block; padding:8px 6px 0; overflow:hidden; font:700 9px/1 ui-monospace,Consolas,monospace; text-align:center; text-overflow:ellipsis; white-space:nowrap; opacity:0; }
  .an-gap:hover span,.an-gap:focus-visible span,.an-gap.on span { opacity:1; }
  .an-wave { position:absolute; inset:3px 7px; width:calc(100% - 14px); height:calc(100% - 6px); opacity:.78; pointer-events:none; }
  .an-marquee { position:fixed; z-index:45; display:none; border:1px solid #69aeff; background:rgba(70,148,235,.16); box-shadow:0 0 0 1px rgba(0,0,0,.24); pointer-events:none; }
  .an-marquee.show { display:block; }
  .an-snap-guide { position:absolute; z-index:25; top:0; bottom:0; left:var(--an-track-label-w); display:none; width:1px; background:repeating-linear-gradient(to bottom,#8bc5ff 0 4px,transparent 4px 7px); filter:drop-shadow(0 0 3px rgba(105,174,255,.8)); pointer-events:none; }
  .an-snap-guide.show { display:block; }
  .an-snap-guide span { position:absolute; left:7px; top:8px; padding:2px 5px; border:1px solid #3e638d; border-radius:4px; color:#dceeff; background:rgba(11,17,25,.94); font:9px/1.2 ui-monospace,Consolas,monospace; white-space:nowrap; }
  .an-timeline-end { position:absolute; z-index:19; top:0; bottom:0; left:var(--an-track-label-w); width:1px; background:#596170; box-shadow:2px 0 0 rgba(0,0,0,.4); pointer-events:none; transform:translateX(var(--an-timeline-end-x,0)); }
  .an-razor-guide { position:absolute; z-index:48; display:none; width:1px; pointer-events:none; }
  .an-razor-guide.show { display:block; }
  .an-razor-guide::before { content:""; position:absolute; inset:0 -1px; background:repeating-linear-gradient(to bottom,#8bc5ff 0 3px,transparent 3px 6px); filter:drop-shadow(0 0 3px rgba(105,174,255,.85)); }
  .an-razor-guide::after { content:""; position:absolute; top:-3px; left:50%; width:7px; height:7px; translate:-50% 0; rotate:45deg; border:1px solid #b9dcff; border-radius:1px; background:#559ce7; box-shadow:0 0 0 2px rgba(7,11,17,.72),0 0 8px rgba(82,159,238,.75); }
  .an-razor-guide span { position:absolute; left:7px; top:-7px; padding:2px 5px; border:1px solid #3e638d; border-radius:4px; color:#dceeff; background:rgba(11,17,25,.94); box-shadow:0 4px 12px rgba(0,0,0,.36); font:9px/1.2 ui-monospace,Consolas,monospace; white-space:nowrap; }
  .an-clip.razor-hover { border-color:#8bc5ff; box-shadow:inset 0 0 0 1px rgba(114,184,255,.24),0 0 0 1px rgba(62,130,203,.42),0 4px 14px rgba(0,0,0,.42); }
  #animaticsWorkspace.tool-select .an-track-lane,#animaticsWorkspace.tool-select .an-clip,#animaticsWorkspace.tool-select #anViewer { cursor:default; }
  #animaticsWorkspace.tool-text #anViewer { cursor:text; }
  #animaticsWorkspace.tool-razor .an-track-lane,#animaticsWorkspace.tool-razor .an-clip { cursor:default; }
  #animaticsWorkspace.tool-razor .an-clip.razor-hover,#animaticsWorkspace.tool-razor .an-clip.razor-hover * { cursor:crosshair; }
  #animaticsWorkspace.tool-hand .an-tl-grid,#animaticsWorkspace.tool-hand .an-track-lane,#animaticsWorkspace.tool-hand .an-clip { cursor:grab; }
  #animaticsWorkspace.hand-panning .an-tl-grid,#animaticsWorkspace.hand-panning .an-track-lane,#animaticsWorkspace.hand-panning .an-clip { cursor:grabbing!important; }
  .an-track-add { position:sticky; left:calc(var(--an-track-label-w) + 8px); z-index:24; display:block; width:max-content; height:32px; padding:0 10px; margin:6px 0 2px calc(var(--an-track-label-w) + 8px); border-radius:8px; border-color:#30343e; font-size:11px; background:#17191f; box-shadow:0 0 0 4px #15181e; }
  .an-playhead { position:absolute; z-index:20; top:0; bottom:0; left:var(--an-track-label-w); width:1px; background:#ff626b; pointer-events:none; transform:translateX(var(--an-playhead-x,0px)); }
  .an-playhead.out-of-view { display:none; }
  .an-playhead::before { content:""; position:absolute; top:0; left:50%; width:13px; height:14px; translate:-50% 0; border-radius:0; clip-path:polygon(0 0,100% 0,100% 64%,50% 100%,0 64%); background:linear-gradient(180deg,#ff7b83 0%,#ff5964 100%); box-shadow:0 0 0 1px rgba(8,10,14,.7); }
  .an-sequence-range { position:absolute; z-index:1; top:0; bottom:0; left:var(--an-track-label-w); pointer-events:none; background:rgba(94,165,255,.07); border-inline:1px solid rgba(94,165,255,.35); transform:translateX(var(--an-in-x,0)); width:var(--an-range-w,0); }
  .an-sequence-marker { position:absolute; z-index:22; top:0; bottom:0; left:var(--an-track-label-w); width:9px; cursor:ew-resize; touch-action:none; background:transparent; transform:translateX(var(--an-marker-x,0)); }
  .an-sequence-marker.out-of-view { display:none; }
  .an-sequence-marker::after { content:""; position:absolute; top:0; bottom:0; left:0; width:1px; background:#65aaff; box-shadow:0 0 7px rgba(101,170,255,.35); }
  .an-sequence-marker::before { position:absolute; top:9px; padding:2px 5px; border-radius:4px; color:#07101d; background:#65aaff; font:700 9px "Segoe UI",sans-serif; }
  .an-sequence-marker.in::before { content:"IN"; left:2px; }
  .an-sequence-marker.out::before { content:"OUT"; left:2px; }
  .an-mark-btn { height:27px; padding:0 8px; border:1px solid #343946; border-radius:7px; color:#aeb6c4; background:#1b1e25; font:600 10px "Segoe UI",sans-serif; cursor:pointer; }
  .an-mark-btn:hover,.an-mark-btn.on { border-color:#5b9eea; color:#eaf4ff; background:#24364c; }
  .an-drop-target { outline:1px solid #65aaff; outline-offset:-2px; background-color:rgba(70,139,223,.12); }
  .an-toast { position:absolute; left:50%; bottom:calc(var(--an-timeline-h) + 16px); translate:-50% 8px; padding:8px 12px; border:1px solid #343844; border-radius:9px; background:#171a21; color:#e9ecf2; opacity:0; pointer-events:none; transition:.18s; box-shadow:0 8px 30px rgba(0,0,0,.35); }
  .an-toast.show { opacity:1; translate:-50% 0; }
  .an-export-modal { position:absolute; inset:0; z-index:50; display:none; place-items:center; background:rgba(5,6,8,.7); backdrop-filter:blur(6px); }
  .an-export-modal.open { display:grid; }
  .an-export-card { width:430px; padding:20px; border:1px solid #343844; border-radius:16px; background:#191b22; box-shadow:0 24px 80px rgba(0,0,0,.6); }
  .an-export-card h2 { margin:0 0 5px; font-size:17px; }
  .an-export-card p { margin:0 0 17px; color:#8f96a4; }
  .an-export-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:17px; }
  .an-sequence-hint { display:flex; justify-content:space-between; margin:-7px 0 13px; color:#747d8c; font-size:10px; }
  .an-progress { height:5px; margin-top:14px; border-radius:99px; overflow:hidden; background:#292c35; display:none; }
  .an-progress.show { display:block; }
  .an-progress i { display:block; width:0; height:100%; background:#67aaff; transition:width .16s; }
  .an-audio-trim-modal { position:absolute; inset:0; z-index:52; display:none; place-items:center; background:rgba(5,6,8,.76); backdrop-filter:blur(7px); }
  .an-audio-trim-modal.open { display:grid; }
  .an-audio-trim-card { width:min(650px,calc(100vw - 44px)); padding:20px; box-sizing:border-box; border:1px solid #363a46; border-radius:16px; background:#191b22; box-shadow:0 24px 90px rgba(0,0,0,.68); }
  .an-audio-trim-card h2 { margin:0 0 4px; font-size:17px; }
  .an-audio-trim-name { margin:0 0 15px; color:#8991a0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .an-wave-shell { position:relative; height:132px; margin-bottom:12px; border:1px solid #303440; border-radius:10px; overflow:hidden; background:#0e1015; cursor:crosshair; }
  #anTrimWave { display:block; width:100%; height:100%; }
  .an-trim-readout { position:absolute; right:8px; top:7px; padding:4px 7px; border-radius:6px; background:rgba(5,7,11,.75); color:#e8edf7; font:10px ui-monospace,Consolas,monospace; pointer-events:none; }
  #anTrimPlayer { width:100%; height:34px; margin-bottom:13px; }
  .an-trim-points { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .an-trim-point { padding:10px; border:1px solid #303440; border-radius:10px; background:#13151b; }
  .an-trim-point h4 { margin:0 0 8px; color:#e8ebf2; font-size:11px; }
  .an-trim-point .an-field { margin-bottom:8px; }
  .an-trim-point .an-tool-btn { margin:0; }
  .an-trim-summary { display:flex; justify-content:space-between; gap:10px; margin-top:12px; color:#8e96a5; }
  .an-trim-summary b { color:#e4e9f2; font:11px ui-monospace,Consolas,monospace; }
  .an-trim-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }

  /* Shared RefBoard appearance system. The canvas stays project-neutral while
     every piece of application chrome follows the selected theme. */
  #animaticsWorkspace {
    --an-bg:var(--bg);
    --an-void:var(--void);
    --an-workspace:var(--workspace);
    --an-surface-1:var(--surface-1);
    --an-surface-2:var(--surface-2);
    --an-surface-3:var(--surface-3);
    --an-line:var(--line);
    --an-line-strong:var(--line-strong);
    --an-text:var(--txt);
    --an-muted:var(--mut);
    --an-dim:var(--dim);
    --an-accent:var(--acc);
    --an-accent-hover:var(--acc-hover);
    --an-accent-contrast:var(--acc-contrast);
    --an-danger:var(--danger);
    --an-shadow:var(--shadow);
    color:var(--an-text);
    background:var(--an-bg);
  }
  .an-top,.an-side,.an-timeline,.an-tl-head { background:var(--an-surface-1); border-color:var(--an-line); }
  .an-tabs,.an-ruler-row,.an-track-label,.an-track-lane { border-color:var(--an-line); }
  .an-tabs,.an-ruler-row,.an-track-label { background:var(--an-surface-1); }
  .an-shot-cluster,.an-time,.an-transport,.an-preview-zoom-hud { border-color:var(--an-line); background:color-mix(in srgb,var(--an-surface-1) 78%,transparent); }
  .an-view-select-button,.an-view-select-menu { border-color:var(--an-line); background:color-mix(in srgb,var(--an-surface-1) 94%,transparent); }
  .an-track-lane,.an-tl-grid { background-color:var(--an-void); }
  .an-brand-name,.an-export-card h2,.an-audio-trim-card h2,.an-trim-point h4 { color:var(--an-text); }
  .an-title,.an-tab.on,.an-section-title { color:var(--an-accent); }
  .an-back,.an-btn,.an-icon,.an-tab { color:var(--an-muted); }
  .an-tool-btn,.an-draw-tool,.an-draw-color-btn,.an-draw-size-btn,.an-mark-btn,.an-track-btn { color:var(--an-muted); border-color:var(--an-line); background:var(--an-surface-1); }
  .an-back:hover,.an-btn:hover,.an-icon:hover,.an-track-add:hover,.an-tab:hover,.an-tool-btn:hover,.an-draw-tool:hover,.an-draw-color-btn:hover,.an-draw-size-btn:hover,.an-mark-btn:hover,.an-track-btn:hover { color:var(--an-text); border-color:var(--an-line-strong); background:var(--an-surface-3); }
  .an-tab.on { color:var(--an-text); border-color:var(--an-line-strong); background:var(--an-surface-3); }
  .an-tool-btn.on,.an-draw-tool.on,.an-draw-size-btn.on,.an-mark-btn.on,.an-track-btn.on { color:var(--an-accent); border-color:color-mix(in srgb,var(--an-accent) 60%,var(--an-line)); background:color-mix(in srgb,var(--an-accent) 13%,var(--an-surface-2)); }
  .an-btn.primary { color:var(--an-accent-contrast); border-color:transparent; background:var(--an-accent); }
  .an-btn.primary:hover { color:var(--an-accent-contrast); background:var(--an-accent-hover); }
  .an-time,.an-field label,.an-stage-foot,.an-track-sub,.an-export-card p,.an-sequence-hint,.an-audio-trim-name,.an-trim-summary { color:var(--an-dim); }
  .an-field input,.an-field textarea,.an-field select,.an-edit-select,.an-draw-size-input { color:var(--an-text); border-color:var(--an-line); background:var(--an-surface-2); }
  .an-field input:hover,.an-field textarea:hover,.an-field select:hover,.an-edit-select:hover,.an-draw-size-input:hover { border-color:var(--an-line-strong); }
  .an-field input:focus,.an-field textarea:focus,.an-field select:focus,.an-edit-select:focus,.an-draw-size-input:focus { outline:1px solid var(--an-accent); border-color:var(--an-accent); }
  .an-field input[type="range"],.an-zoom input[type="range"] { accent-color:var(--an-accent); }
  .an-field input[type="range"]::-webkit-slider-runnable-track,.an-zoom input[type="range"]::-webkit-slider-runnable-track { background:var(--an-surface-3); }
  .an-field input[type="range"]::-webkit-slider-thumb,.an-zoom input[type="range"]::-webkit-slider-thumb { background:var(--an-accent); border-color:var(--an-accent-contrast); }
  .an-draw-size-menu,.an-draw-color-pop,.an-toast,.an-export-card,.an-audio-trim-card,.an-trim-point { color:var(--an-text); border-color:var(--an-line-strong); background:var(--an-surface-1); box-shadow:var(--an-shadow); }
  .an-draw-size-option:hover,.an-draw-size-option.on { color:var(--an-accent); background:color-mix(in srgb,var(--an-accent) 12%,var(--an-surface-2)); }
  .an-wave-shell { border-color:var(--an-line); background:var(--an-void); }
  .an-progress { background:var(--an-surface-3); }
  .an-progress i { background:var(--an-accent); }
  .an-export-modal,.an-audio-trim-modal { background:var(--scrim); }
  .an-track-add { border-color:var(--an-line); background:var(--an-surface-1); box-shadow:0 0 0 4px var(--an-bg); }
  .an-sequence-range { background:color-mix(in srgb,var(--an-accent) 8%,transparent); border-inline-color:color-mix(in srgb,var(--an-accent) 42%,transparent); }
  .an-sequence-marker::after { background:var(--an-accent); box-shadow:0 0 7px color-mix(in srgb,var(--an-accent) 38%,transparent); }
  .an-sequence-marker::before { color:var(--an-accent-contrast); background:var(--an-accent); }
  .an-drop-target { outline-color:var(--an-accent); background-color:color-mix(in srgb,var(--an-accent) 12%,transparent); }
  .an-clip:hover,.an-clip.on,.an-clip:focus-visible { border-color:var(--an-accent); box-shadow:0 0 0 1px color-mix(in srgb,var(--an-accent) 38%,transparent),0 7px 22px rgba(0,0,0,.38); }
  .an-ruler-tick.major::after,.an-ruler-label { color:var(--an-dim); }
  .an-timeline ::-webkit-scrollbar-thumb,.an-side ::-webkit-scrollbar-thumb { background:var(--an-surface-3); border-color:var(--an-surface-1); }
  .an-timeline ::-webkit-scrollbar-thumb:hover,.an-side ::-webkit-scrollbar-thumb:hover { background:var(--an-line-strong); }
  @media(max-width:900px){ .an-top-actions{min-width:auto}.an-brand{min-width:auto}.an-stage{padding-inline:12px}.an-stage-foot{gap:6px}.an-shot-cluster{display:none}.an-time{min-width:0;padding-inline:7px}.an-transport{min-width:0}.an-view-select.quality{min-width:96px} }
  `;
}

function icon(path, fill = false) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"${fill ? ' style="fill:currentColor;stroke:none"' : ''}>${path}</svg>`;
}

function previewVolumeIcon(muted=false){return icon(muted?'<path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="m15 9 6 6M21 9l-6 6"/>':'<path d="M11 5 6.5 9H3v6h3.5L11 19z"/><path d="M15 9a4 4 0 0 1 0 6M17.8 6.2a8 8 0 0 1 0 11.6"/>');}

function selectionToolIcon(){return '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 7.5-6 .75L9 20l-1.5-6.5L5 3z"/></svg>';}
function razorToolIcon(){return '<svg viewBox="0 0 32 32" aria-hidden="true"><g transform="rotate(-28 16 16)" stroke-linejoin="round"><path d="M5 6h22v13l-8 7H5Z" fill="#080a0e" stroke="currentColor" stroke-width="1.8"/><path d="M5 20h13l9-8v7l-8 7H5Z" fill="#70b5ff" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="13" r="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/></g></svg>';}
function handToolIcon(){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.1 11.2V7.6a1.45 1.45 0 0 1 2.9 0v2.1-4a1.5 1.5 0 0 1 3 0v3.7-2.8a1.45 1.45 0 0 1 2.9 0v3.3-1.7a1.4 1.4 0 0 1 2.8 0v5.3c0 4.5-2.7 7.1-6.8 7.1-2.6 0-4.2-1.2-5.5-3.1l-2.3-3.4a1.55 1.55 0 0 1 2.4-1.9Z" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg>';}
function linkToolIcon(){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.4 14.6 5.2-5.2M7.8 16.2l-1.1 1.1a3.2 3.2 0 0 1-4.5-4.5l3.1-3.1a3.2 3.2 0 0 1 4.5 0M16.2 7.8l1.1-1.1a3.2 3.2 0 0 1 4.5 4.5l-3.1 3.1a3.2 3.2 0 0 1-4.5 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';}
function visibilityIcon(visible=true){return visible?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.7"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.4 6.2A10.8 10.8 0 0 1 12 6c6 0 9.5 6 9.5 6a16.7 16.7 0 0 1-3.1 3.7M6.2 6.3C3.8 8 2.5 12 2.5 12s3.5 6 9.5 6c1.5 0 2.8-.4 4-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';}
function lockIcon(locked=false){return locked?'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M9 10V7a4 4 0 0 1 7.5-2"/></svg>';}

function markup() {
  return `<section id="animaticsWorkspace" aria-hidden="true">
    <header class="an-top">
      <div class="an-brand"><button class="an-back" id="anBack" title="Back to board">${icon('<path d="m15 18-6-6 6-6"/>')}</button><div class="an-brand-lockup"><img class="an-brand-mark" id="anBrandMark" alt="" aria-hidden="true"><span class="an-brand-name">RefBoard</span><span class="an-title">Animatics</span></div></div>
      <div class="an-top-actions"><button class="an-btn" id="anInspector">Tools</button><button class="an-btn primary" id="anExport">Export</button></div>
    </header>
    <div class="an-stage-row">
      <aside class="an-side"><div class="an-side-inner">
        <nav class="an-tabs"><button class="an-tab on" data-panel="clip">Clip</button><button class="an-tab" data-panel="text">Text</button><button class="an-tab" data-panel="audio">Audio</button><button class="an-tab" data-panel="draw">Draw</button><button class="an-tab" data-panel="view">View</button></nav>
        <div class="an-panel on" data-panel-body="clip"><h3 class="an-section-title" id="anClipSelectionTitle">Selected clip</h3><div class="an-split"><label class="an-field">Seconds<input id="anDuration" type="number" min="0.017" max="600" step="0.1" placeholder="Mixed"></label><label class="an-field">Frames<input id="anDurationFrames" type="number" min="1" max="36000" step="1" placeholder="Mixed"></label></div><h3 class="an-section-title" id="anFramingTitle">16:9 framing</h3><div class="an-frame-actions"><button class="an-tool-btn" id="anFrameFit">Fit</button><button class="an-tool-btn" id="anFrameFill">Fill</button><button class="an-tool-btn" id="anFrameReset">Reset</button></div><label class="an-field">Scale<div class="an-scale-row"><input id="anFrameScale" type="range" min="25" max="800" value="100"><output id="anFrameScaleVal">100%</output></div></label><button class="an-tool-btn" id="anToggleClipVisibility" title="Enable or disable selected visual clips (Ctrl+H)" aria-pressed="false">Disable selected</button><div class="an-split"><button class="an-tool-btn" id="anSplit">Split at playhead</button><button class="an-tool-btn" id="anDeleteClip">Delete selected</button></div></div>
        <div class="an-panel" data-panel-body="text">
          <h3 class="an-section-title">Text overlay layer</h3>
          <label class="an-field">Content<textarea id="anText" placeholder="Add a title or annotation…"></textarea></label>
          <label class="an-field">Font family<select id="anTextFont"><option value="Segoe UI">Segoe UI</option><option value="Arial">Arial</option><option value="Helvetica">Helvetica</option><option value="Times New Roman">Times New Roman</option><option value="Georgia">Georgia</option><option value="Courier New">Courier New</option><option value="Verdana">Verdana</option><option value="Trebuchet MS">Trebuchet MS</option><option value="Impact">Impact</option><option value="Comic Sans MS">Comic Sans MS</option></select></label>
          <div class="an-split"><button type="button" class="an-tool-btn" id="anTextBold" aria-pressed="false">Bold</button><button type="button" class="an-tool-btn" id="anTextItalic" aria-pressed="false">Italic</button></div>
          <button type="button" class="an-tool-btn" id="anTextBackground" aria-pressed="false">Background</button>
          <div class="an-field">Alignment<div class="an-frame-actions" role="group" aria-label="Text alignment"><button type="button" class="an-tool-btn" data-an-text-align="left" aria-pressed="false">Left</button><button type="button" class="an-tool-btn on" data-an-text-align="center" aria-pressed="true">Center</button><button type="button" class="an-tool-btn" data-an-text-align="right" aria-pressed="false">Right</button></div></div>
          <div class="an-split"><label class="an-field">Font size<input id="anTextSize" type="number" min="8" max="300" value="42"></label><div class="an-field"><span>Color</span><button type="button" class="an-draw-color-btn an-text-color-btn" id="anTextColorButton" aria-expanded="false" aria-controls="anTextColorPop"><span class="an-draw-color-swatch" id="anTextColorSwatch"></span><span>Text color</span></button><input id="anTextColor" type="hidden" value="#ffffff"></div></div>
          <div class="an-draw-color-pop an-text-color-pop" id="anTextColorPop" aria-hidden="true"><div class="an-draw-cp-sv" id="anTextCpSv"><div class="an-draw-cp-white"></div><div class="an-draw-cp-black"></div><div class="an-draw-cp-dot" id="anTextCpDot"></div></div><input class="an-draw-cp-hue" id="anTextCpHue" type="range" min="0" max="360" value="0" aria-label="Text hue"><div class="an-draw-cp-row"><span class="an-draw-cp-preview" id="anTextCpPreview"></span><input class="an-draw-cp-hex" id="anTextCpHex" type="text" maxlength="7" spellcheck="false" autocomplete="off" aria-label="Text color hex"></div><div class="an-draw-cp-presets" id="anTextCpPresets"></div></div>
          <label class="an-field">Scale<div class="an-scale-row"><input id="anTextScale" type="range" min="25" max="400" value="100"><output id="anTextScaleVal">100%</output></div></label>
          <div class="an-split"><label class="an-field">Rotation<input id="anTextRotation" type="number" min="-180" max="180" step="1" value="0"></label><label class="an-field">Duration (sec)<input id="anTextDuration" type="number" min="0.017" max="600" step="0.1" value="3"></label></div>
          <button class="an-tool-btn" id="anAddText">Add text layer</button><button class="an-tool-btn" id="anClearText">Delete selected text</button>
        </div>
        <div class="an-panel" data-panel-body="audio"><h3 class="an-section-title" id="anAudioSelectionTitle">Selected audio</h3><div class="an-split"><label class="an-field">Seconds<input id="anAudioDuration" type="number" min="0.017" max="600" step="0.1" placeholder="Mixed"></label><label class="an-field">Frames<input id="anAudioDurationFrames" type="number" min="1" max="36000" step="1" placeholder="Mixed"></label></div><label class="an-field">Volume<div class="an-scale-row"><input id="anAudioVolume" type="range" min="0" max="400" step="1" value="100"><output id="anAudioVolumeVal">100%</output></div></label><button class="an-tool-btn" id="anAudioGain">Audio Gain (G)</button><button class="an-tool-btn" id="anAudioMute">Mute selected</button><div class="an-fade-controls"><div class="an-fade-card"><h4>Fade in</h4><label class="an-field">Seconds<input id="anFadeInDuration" type="number" min="0" max="600" step="0.033"></label><label class="an-field">Curve<select id="anFadeInCurve"><option value="constant-gain">Constant Gain</option><option value="constant-power">Constant Power</option><option value="exponential">Exponential Fade</option><option value="custom">Custom</option></select></label><label class="an-field an-fade-custom" id="anFadeInCustom">Custom shape<input id="anFadeInShape" type="range" min="-100" max="100" step="1" value="0"></label></div><div class="an-fade-card"><h4>Fade out</h4><label class="an-field">Seconds<input id="anFadeOutDuration" type="number" min="0" max="600" step="0.033"></label><label class="an-field">Curve<select id="anFadeOutCurve"><option value="constant-gain">Constant Gain</option><option value="constant-power">Constant Power</option><option value="exponential">Exponential Fade</option><option value="custom">Custom</option></select></label><label class="an-field an-fade-custom" id="anFadeOutCustom">Custom shape<input id="anFadeOutShape" type="range" min="-100" max="100" step="1" value="0"></label></div></div><div class="an-split"><button class="an-tool-btn" id="anAudioSplit">Split at playhead</button><button class="an-tool-btn" id="anAudioDelete">Delete selected</button></div></div>
        <div class="an-panel" data-panel-body="draw"><h3 class="an-section-title">Draw on shot</h3><button class="an-tool-btn" id="anDrawToggle" title="Toggle drawing (D)">Start drawing (D)</button><div class="an-draw-tool-row"><button class="an-draw-tool on" id="anDrawPen" aria-expanded="false" aria-controls="anDrawBrushes"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span>Pen</span></button><button class="an-draw-tool" id="anDrawEraser" title="Eraser (E)"><svg viewBox="0 0 24 24"><path d="m4 15 8-10 8 7-7 8H8Z"/><path d="m9 12 7 6M8 20h12"/></svg><span>Eraser</span><kbd>E</kbd></button></div><div class="an-draw-brushes" id="anDrawBrushes"><button class="an-draw-brush on" data-an-brush="pen"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span>Pen</span></button><button class="an-draw-brush" data-an-brush="soft"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="6" opacity=".45"/></svg><span>Soft</span></button><button class="an-draw-brush" data-an-brush="marker"><svg viewBox="0 0 24 24"><path d="M6 18h12" stroke-width="3" opacity=".55"/><path d="m7 14 9-7 2.5 2.5-9 7H7Z"/></svg><span>Marker</span></button><button class="an-draw-brush" data-an-brush="pencil"><svg viewBox="0 0 24 24"><path d="m14.5 3.5 6 6L9 21l-5 1 1-5ZM13 5l6 6"/></svg><span>Pencil</span></button></div><button class="an-draw-color-btn" id="anDrawColorButton" aria-expanded="false" aria-controls="anDrawColorPop"><span class="an-draw-color-swatch" id="anDrawColorSwatch"></span><span>Color</span></button><div class="an-draw-color-pop" id="anDrawColorPop" aria-hidden="true"><div class="an-draw-cp-sv" id="anDrawCpSv"><div class="an-draw-cp-white"></div><div class="an-draw-cp-black"></div><div class="an-draw-cp-dot" id="anDrawCpDot"></div></div><input class="an-draw-cp-hue" id="anDrawCpHue" type="range" min="0" max="360" value="0" aria-label="Drawing hue"><div class="an-draw-cp-row"><span class="an-draw-cp-preview" id="anDrawCpPreview"></span><input class="an-draw-cp-hex" id="anDrawCpHex" type="text" maxlength="7" spellcheck="false" autocomplete="off" aria-label="Drawing color hex"></div><div class="an-draw-cp-presets" id="anDrawCpPresets"></div></div><div class="an-draw-size-row"><button class="an-draw-size-btn" id="anDrawWidthDown" title="Thinner ([)">−</button><output class="an-draw-size-value" id="anDrawWidthVal">2 <kbd>[ ]</kbd></output><button class="an-draw-size-btn" id="anDrawWidthUp" title="Thicker (])">+</button></div><button class="an-tool-btn" id="anClearDraw">Clear drawing</button></div>
        <div class="an-panel" data-panel-body="view"><h3 class="an-section-title">Viewer</h3><div class="an-split"><label class="an-field">Playback counter<select id="anCounterMode"><option value="timecode">Timecode</option><option value="frames">Frames</option><option value="seconds">Seconds</option></select></label><label class="an-field">Project rate<select id="anProjectFps"><option value="24">24 fps</option><option value="30">30 fps</option><option value="60">60 fps</option></select></label></div><button class="an-tool-btn" id="anTcToggle">Show counter in picture</button><label class="an-field">Background<select id="anBackground"><option value="#000000">Black</option><option value="#181a20">Charcoal</option><option value="#ffffff">White</option></select></label></div>
      </div></aside><div class="an-side-resizer" id="anInspectorResizer" role="separator" aria-label="Resize inspector" aria-orientation="vertical" aria-valuemin="${MIN_INSPECTOR_WIDTH}" aria-valuemax="${MAX_INSPECTOR_WIDTH}" aria-valuenow="${DEFAULT_INSPECTOR_WIDTH}" tabindex="0" title="Drag to resize tools · double-click to reset"></div>
      <main class="an-stage"><div class="an-viewer-wrap"><div class="an-viewer-viewport"><div class="an-viewer-shell"><canvas id="anViewer" width="1920" height="1080"></canvas><div class="an-draw-size-preview" id="anDrawSizePreview" aria-hidden="true"></div><div class="an-empty-stage" id="anEmpty"><div>No clips at the playhead<br><small>Add or move images in the timeline</small></div></div></div></div><div class="an-preview-zoom-hud" id="anPreviewZoomHud" role="group" aria-label="Preview zoom"><span class="an-preview-zoom-value" id="anPreviewZoomValue">100%</span><button class="an-preview-zoom-action" id="anPreviewFit" type="button" title="Fit preview">Fit</button><button class="an-preview-zoom-action" id="anPreviewLock" type="button" aria-pressed="false" title="Freeze preview zoom and position">Lock</button></div><div class="an-stage-foot"><div class="an-footer-left"><span class="an-time" id="anTime">00:00:00:00 / 00:00:00:00</span><div class="an-shot-cluster"><span id="anShotLabel">No shot selected</span></div></div><div class="an-transport" role="toolbar" aria-label="Viewer playback"><button class="an-icon" id="anPrev" title="Previous frame">${icon('<path d="M7 5v14M18 6l-8 6 8 6z"/>')}</button><button class="an-play" id="anPlay" title="Play / pause">${icon('<path d="m8 5 11 7-11 7z"/>',true)}</button><button class="an-icon" id="anNext" title="Next frame">${icon('<path d="M17 5v14M6 6l8 6-8 6z"/>')}</button></div><div class="an-view-settings"><select id="anFooterAspect" aria-label="Sequence aspect"><option value="16:9">16:9</option><option value="4:3">4:3</option><option value="5:4">5:4</option><option value="9:16">9:16</option><option value="21:9">21:9</option></select><select id="anFooterQuality" aria-label="Preview quality"><option value="full">Full 1080p</option><option value="half">Half 540p</option><option value="low">Low 270p</option></select></div></div></div></main><aside></aside>
    </div>
    <section class="an-timeline"><div class="an-timeline-resizer" id="anTimelineResizer" role="separator" aria-label="Resize timeline" aria-orientation="horizontal" tabindex="0" title="Drag to resize timeline · double-click to reset"></div><div class="an-tl-head"><div class="an-edit-tools" role="toolbar" aria-label="Timeline tools"><button class="an-edit-tool on" data-an-tool="select" title="Selection tool (V)" aria-label="Selection tool">${selectionToolIcon()}</button><button class="an-edit-tool" data-an-tool="text" title="Text tool (T)" aria-label="Text tool"><span class="text-glyph">T</span></button><button class="an-edit-tool" data-an-tool="razor" title="Razor tool (C)" aria-label="Razor tool">${razorToolIcon()}</button></div><button class="an-icon an-snap-btn on" id="anSnap" title="Timeline snapping (S)" aria-pressed="true">⌁ Snap</button><button class="an-icon" id="anAddImages" title="Add selected board images">${icon('<path d="M12 5v14M5 12h14"/>')}</button><button class="an-icon" id="anAddVideo" title="Add video">${icon('<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>')}</button><button class="an-icon" id="anAddAudio" title="Add audio">${icon('<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>')}</button><button class="an-mark-btn" id="anSequenceSettings" title="Sequence duration and timeline display">Sequence</button><button class="an-mark-btn" id="anSetIn" title="Set sequence In point (I)">Set In</button><button class="an-mark-btn" id="anSetOut" title="Set sequence Out point (O)">Set Out</button><button class="an-mark-btn" id="anClearRange" title="Clear sequence In/Out">Clear</button><span id="anTlSummary">0 clips · 0:00</span><label class="an-zoom">Timeline <input id="anZoom" type="range" min="0.001" max="320" step="0.001" value="90"></label></div><div class="an-tl-scroll" id="anTlScroll"><div class="an-tl-grid" id="anTlGrid"><div class="an-playhead"></div></div></div><div class="an-marquee" id="anMarquee"></div><div class="an-razor-guide" id="anRazorGuide"><span></span></div></section>
    <input id="anAudioPick" type="file" accept="audio/*" multiple hidden>
    <input id="anVideoPick" type="file" accept="video/*" multiple hidden>
    <div class="an-toast" id="anToast"></div>
    <div class="an-export-modal" id="anSequenceModal"><div class="an-export-card"><h2>Sequence settings</h2><p>Enter a custom timeline duration or let the sequence follow its content.</p><div class="an-split"><label class="an-field">Timeline length<select id="anSequenceMode"><option value="fixed">Custom duration</option><option value="auto">Auto — fit content</option></select></label><label class="an-field">Timeline display<select id="anTimelineDisplay"><option value="timecode">Timecode</option><option value="frames">Frames</option></select></label></div><label class="an-field">Custom duration<input id="anSequenceDuration" type="text" inputmode="numeric" spellcheck="false" autocomplete="off" placeholder="00:03:00:00" aria-describedby="anSequenceFormat anSequenceMinimum"></label><div class="an-sequence-hint"><span id="anSequenceFormat">HH:MM:SS:FF · typing switches to Custom</span><span id="anSequenceMinimum"></span></div><div class="an-export-actions"><button class="an-btn" id="anSequenceCancel">Cancel</button><button class="an-btn primary" id="anSequenceApply">Apply</button></div></div></div>
    <div class="an-export-modal" id="anExportModal"><div class="an-export-card"><h2>Export animatic</h2><p id="anExportDescription">MP4 · H.264 · stereo audio · <span id="anExportAspect">16:9</span></p><label class="an-field">Format<select id="anExportFormat"><option value="mp4">MP4 video</option><option value="premiere">Premiere Pro 2025–2026 timeline (.xml)</option><option value="after-effects">After Effects project builder (.jsx → .aep)</option></select></label><div class="an-split"><label class="an-field">Resolution<select id="anExportRes"><option value="1080">1080p</option><option value="720">720p</option><option value="480">480p</option></select></label><label class="an-field">Frame rate<select id="anExportFps"><option value="24">24 fps</option><option value="30" selected>30 fps</option><option value="60">60 fps</option></select></label></div><label class="an-field">Export range<select id="anExportRange"><option value="full">Full sequence</option><option value="inout">Sequence In to Out</option></select></label><label class="an-field" id="anExportCounterField">Counter overlay<select id="anExportTc"><option value="project">Use viewer setting</option><option value="on">Burn selected counter</option><option value="off">No counter</option></select></label><div class="an-progress" id="anExportProgress"><i></i></div><div class="an-export-actions"><button class="an-btn" id="anExportCancel">Cancel</button><button class="an-btn primary" id="anExportGo">Export MP4</button></div></div></div>
    <div class="an-export-modal" id="anGainModal"><div class="an-export-card"><h2>Audio Gain</h2><p id="anGainScope">Selected audio clips</p><label class="an-field">Operation<select id="anGainMode"><option value="set">Set Gain To</option><option value="adjust">Adjust Gain By</option></select></label><label class="an-field">Gain (dB)<input id="anGainDb" type="number" min="-96" max="12" step="0.1" value="0"></label><p class="an-sequence-hint"><span id="anGainCurrent">Current gain 0 dB</span><span>-96 dB to +12 dB</span></p><div class="an-export-actions"><button class="an-btn" id="anGainCancel">Cancel</button><button class="an-btn primary" id="anGainApply">Apply Gain</button></div></div></div>
    <div class="an-audio-trim-modal" id="anAudioTrimModal"><div class="an-audio-trim-card"><h2>Trim audio</h2><p class="an-audio-trim-name" id="anTrimName">Audio</p><div class="an-wave-shell" id="anTrimWaveShell"><canvas id="anTrimWave" width="1200" height="260"></canvas><span class="an-trim-readout" id="anTrimReadout">00:00:00:00</span></div><audio id="anTrimPlayer" controls preload="metadata"></audio><div class="an-trim-points"><div class="an-trim-point"><h4>In point</h4><label class="an-field">Frame<input id="anTrimInFrames" type="number" min="0" step="1"></label><button class="an-tool-btn" id="anTrimSetIn">Set In at playhead</button></div><div class="an-trim-point"><h4>Out point</h4><label class="an-field">Frame<input id="anTrimOutFrames" type="number" min="1" step="1"></label><button class="an-tool-btn" id="anTrimSetOut">Set Out at playhead</button></div></div><div class="an-trim-summary"><span>Selected range</span><b id="anTrimSummary">0 frames · 0.00s</b></div><div class="an-trim-actions"><button class="an-btn" id="anTrimPlaySelection">Play selection</button><button class="an-btn" id="anTrimCancel">Cancel</button><button class="an-btn primary" id="anTrimUse">Use audio</button></div></div></div>
  </section>`;
}

export function createAnimaticsEditor(options) {
  const { getImage, getBitmap, getBlob, getBoardTransform = item => item, onImportImages = async () => [], onDirty = () => {}, onOpen = () => {}, onClose = () => {}, toast: boardToast = () => {} } = options;
  const style = document.createElement('style');
  style.id = 'animaticsStyles';
  style.textContent = css();
  document.head.append(style);
  const workspaceMarkup=markup().replace('<output class="an-draw-size-value" id="anDrawWidthVal">2 <kbd>[ ]</kbd></output>','<div class="an-draw-size-combo"><input class="an-draw-size-value" id="anDrawWidthVal" type="number" min="1" max="48" step="1" value="2" aria-label="Brush size"><button class="an-draw-size-menu-btn" id="anDrawWidthMenuButton" type="button" aria-label="Brush size presets" aria-haspopup="listbox" aria-expanded="false"><svg viewBox="0 0 16 16"><path d="m4 6 4 4 4-4"/></svg></button><div class="an-draw-size-menu" id="anDrawWidthMenu" role="listbox" aria-label="Brush size presets"></div></div>');
  document.body.insertAdjacentHTML('beforeend',workspaceMarkup);

  const root = document.querySelector('#animaticsWorkspace');
  root.querySelector('.an-edit-tools')?.insertAdjacentHTML('beforeend',`<button class="an-edit-tool" data-an-tool="hand" title="Hand tool (H)" aria-label="Hand tool">${handToolIcon()}</button><span class="an-edit-divider" aria-hidden="true"></span><button class="an-edit-tool" id="anLink" title="Link selected clips (Ctrl+L)" aria-label="Link selected clips" aria-pressed="false">${linkToolIcon()}</button>`);
  root.querySelector('#anViewer')?.insertAdjacentHTML('afterend','<div class="an-safe-guides" id="anSafeGuides" aria-hidden="true"><i class="an-safe-guide action"></i><i class="an-safe-guide title"></i><i class="an-safe-center"></i></div>');
  root.querySelector('.an-transport')?.insertAdjacentHTML('afterbegin',`<button class="an-icon" id="anGuides" type="button" title="Toggle title/action safe guides" aria-label="Toggle title and action safe guides" aria-pressed="false">${icon('<rect x="3" y="4" width="18" height="16"/><rect x="7" y="7" width="10" height="10"/>')}</button>`);
  root.querySelector('.an-transport')?.insertAdjacentHTML('beforeend',`<button class="an-icon" id="anPreviewMute" type="button" title="Mute timeline preview" aria-label="Mute timeline preview" aria-pressed="false">${previewVolumeIcon(false)}</button>`);
  const canonicalBrandMark=document.querySelector('#landingBrandIcon')?.currentSrc||document.querySelector('#landingBrandIcon')?.src||document.querySelector('#titlebarIcon')?.currentSrc||document.querySelector('#titlebarIcon')?.src||'';
  if(canonicalBrandMark)root.querySelector('#anBrandMark').src=canonicalBrandMark;
  const canvas = root.querySelector('#anViewer');
  const viewerViewport = canvas.parentElement.parentElement;
  const ctx = canvas.getContext('2d');
  const inlineTextEditor=document.createElement('textarea');inlineTextEditor.className='an-inline-text';inlineTextEditor.setAttribute('aria-label','Edit text on canvas');canvas.parentElement.append(inlineTextEditor);
  const inlineTextDismissEvents=new WeakSet();
  const grid = root.querySelector('#anTlGrid');
  const scroll = root.querySelector('#anTlScroll');
  const $ = selector => root.querySelector(selector);
  const animaticsSelectControls = new Map();

  function closeAnimaticsSelectMenus(except=null){
    for(const control of animaticsSelectControls.values()){
      if(control===except)continue;
      control.root.classList.remove('open');control.menu.classList.remove('open');
      control.button.setAttribute('aria-expanded','false');
    }
  }

  function syncAnimaticsSelectControl(select){
    const control=animaticsSelectControls.get(select);if(!control)return;
    const selected=select.options[select.selectedIndex];
    control.label.textContent=selected?.textContent||'';control.button.disabled=select.disabled;
    for(const option of control.options){
      const on=option.dataset.value===select.value;option.classList.toggle('on',on);option.setAttribute('aria-selected',String(on));
    }
  }

  function syncAnimaticsSelectControls(){for(const select of animaticsSelectControls.keys())syncAnimaticsSelectControl(select);}

  function positionAnimaticsSelectMenu(control){
    if(!control?.menu.classList.contains('open'))return;
    const rect=control.button.getBoundingClientRect(),gap=6,margin=8;
    control.menu.style.width='auto';control.menu.style.maxHeight=`${Math.max(80,window.innerHeight-margin*2)}px`;
    const naturalWidth=Math.max(rect.width,control.menu.scrollWidth+2),width=Math.min(naturalWidth,window.innerWidth-margin*2);
    control.menu.style.width=`${Math.round(width)}px`;
    const desiredHeight=Math.min(control.menu.scrollHeight,260),below=Math.max(0,window.innerHeight-rect.bottom-gap-margin),above=Math.max(0,rect.top-gap-margin),opensUp=control.preferUp?above>=Math.min(desiredHeight,80):below<desiredHeight&&above>below,available=Math.max(80,opensUp?above:below),height=Math.min(desiredHeight,available);
    control.menu.style.maxHeight=`${Math.round(height)}px`;
    const left=clamp(rect.left,margin,Math.max(margin,window.innerWidth-width-margin)),top=opensUp?Math.max(margin,rect.top-gap-height):Math.min(window.innerHeight-margin-height,rect.bottom+gap);
    control.menu.style.left=`${Math.round(left)}px`;control.menu.style.top=`${Math.round(top)}px`;control.menu.dataset.placement=opensUp?'up':'down';
  }

  function setupAnimaticsSelect(select,{quality=false,compact=false,preferUp=false}={}){
    if(!select||animaticsSelectControls.has(select))return;
    const controlRoot=document.createElement('div');controlRoot.className=`an-view-select${compact?' compact':''}${quality?' quality':''}`;
    select.before(controlRoot);controlRoot.append(select);select.classList.add('an-view-select-native');select.tabIndex=-1;
    const button=document.createElement('button');button.type='button';button.className='an-view-select-button';button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');button.setAttribute('aria-label',select.getAttribute('aria-label')||'Choose option');
    const label=document.createElement('span'),chevron=document.createElementNS('http://www.w3.org/2000/svg','svg');chevron.setAttribute('viewBox','0 0 24 24');chevron.setAttribute('aria-hidden','true');chevron.innerHTML='<path d="m7 9 5 5 5-5"/>';button.append(label,chevron);controlRoot.append(button);
    const menu=document.createElement('div');menu.className='an-view-select-menu';menu.id=`anSelectMenu-${select.id}`;menu.setAttribute('role','listbox');menu.setAttribute('aria-label',select.getAttribute('aria-label')||'Options');button.setAttribute('aria-controls',menu.id);
    const options=[];
    for(const nativeOption of select.options){
      const option=document.createElement('button');option.type='button';option.className='an-view-select-option';option.dataset.value=nativeOption.value;option.setAttribute('role','option');option.textContent=nativeOption.textContent;
      option.addEventListener('click',()=>{select.value=nativeOption.value;select.dispatchEvent(new Event('change',{bubbles:true}));syncAnimaticsSelectControl(select);closeAnimaticsSelectMenus();button.focus();});menu.append(option);options.push(option);
    }
    root.append(menu);
    const control={select,root:controlRoot,button,label,menu,options,preferUp};animaticsSelectControls.set(select,control);
    button.addEventListener('click',()=>{if(button.disabled)return;const opening=!menu.classList.contains('open');if(opening)setTextColorOpen(false);closeAnimaticsSelectMenus(control);controlRoot.classList.toggle('open',opening);menu.classList.toggle('open',opening);button.setAttribute('aria-expanded',String(opening));if(opening)requestAnimationFrame(()=>{positionAnimaticsSelectMenu(control);menu.querySelector('.on')?.focus();});});
    button.addEventListener('keydown',e=>{if(!['ArrowDown','ArrowUp'].includes(e.key))return;e.preventDefault();if(!menu.classList.contains('open'))button.click();});
    menu.addEventListener('keydown',e=>{const index=options.indexOf(document.activeElement);if(e.key==='Escape'){closeAnimaticsSelectMenus();button.focus();e.preventDefault();e.stopPropagation();return;}if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;const next=e.key==='Home'?0:e.key==='End'?options.length-1:(index+(e.key==='ArrowDown'?1:-1)+options.length)%options.length;options[next]?.focus();e.preventDefault();});
    select.addEventListener('change',()=>syncAnimaticsSelectControl(select));syncAnimaticsSelectControl(select);
  }

  root.querySelectorAll('select').forEach(select=>{const compact=!!select.closest('.an-view-settings');setupAnimaticsSelect(select,{compact,preferUp:compact,quality:select.id==='anFooterQuality'});});
  root.addEventListener('pointerdown',e=>{if(!e.target.closest?.('.an-view-select,.an-view-select-menu'))closeAnimaticsSelectMenus();},true);
  root.addEventListener('scroll',()=>{for(const control of animaticsSelectControls.values())if(control.menu.classList.contains('open'))positionAnimaticsSelectMenu(control);},true);
  window.addEventListener('resize',()=>closeAnimaticsSelectMenus());
  let project = freshProject();
  let selectedClipId = null;
  let selectedTextId = null;
  let selectedAudioId = null;
  let selectedTimelineIds = new Set();
  let selectedGap = null;
  let activeVideoTrack = 0;
  let activeAudioTrack = 0;
  let timelineClipboard = null;
  let activeTool = 'select';
  let open = false;
  let playing = false;
  let playStartedAt = 0;
  let playStartedTime = 0;
  let raf = 0;
  let drawMode = false;
  let drawTool = 'pen';
  let drawBrushType = 'pen';
  let drawColor = '#ff5c5c';
  const drawToolWidths = {pen:2,eraser:15};
  let drawWidth = drawToolWidths.pen;
  let drawBrushesOpen = false;
  let drawColorOpen = false;
  let drawWidthMenuOpen = false;
  let drawColorH = 0, drawColorS = 0, drawColorV = 0;
  let textColorOpen = false;
  let textColorH = 0, textColorS = 0, textColorV = 1;
  let drawPointer = {x:.5,y:.5,inside:false};
  let drawSizePreviewTimer = 0;
  let activeStroke = null;
  let activeDrawingClipId = null;
  let activeDrawingOverlay = null;
  let activeDrawingStrokeCanvas = null;
  let activeDrawingRaf = 0;
  let thumbUrls = new Map();
  let toastTimer = 0;
  let dragging = null;
  let audioFadeDrag = null;
  let audioFadeDragRaf = 0;
  let handPan = null;
  let spaceHand = null;
  const PREVIEW_ZOOM_MIN = .5;
  const PREVIEW_ZOOM_MAX = 4;
  let previewZoom = 1;
  let previewPanX = 0;
  let previewPanY = 0;
  let previewZoomLocked = false;
  let previewPanDrag = null;
  let previewZoomHudTimer = 0;
  let previewShotKey = '';
  let safeGuidesVisible = false;
  let previewMuted = false;
  let marqueeDrag = null;
  let gapPress = null;
  let audioPlayers = [];
  let playbackAudioContext = null;
  const audioWaveformCache = new Map();
  const audioWaveformJobs = new Map();
  const mediaResources = new Map();
  let audioWaveformEpoch = 0;
  let audioTimers = [];
  let videoTimers = [];
  const videoFrameCallbacks = new Map();
  let videoCompositeRaf = 0;
  let scrubbing = null;
  let scrubPreviewRaf = 0;
  let scrubPreviewBusy = false;
  let scrubPreviewQueued = false;
  let viewerDrawToken = 0;
  let framingMode = false;
  let framingDrag = null;
  let framingPreviewRaf = 0;
  let framingPreviewFinishTimer = 0;
  let audioTrimState = null;
  let audioTrimResolve = null;
  let trimWavePeaks = [];
  let trimHandleDrag = null;
  let timelineResize = null;
  let timelineResizeRaf = 0;
  let inspectorResize = null;
  let trackResize = null;
  let trackReorder = null;
  let textDrag = null;
  let inlineTextId = null;
  let inlineTextOriginal = '';
  let sequenceMarkerDrag = null;
  let gainDialogIds = [];
  let razorHoverClip = null;
  let timelineFitZoom = null;
  let deferredHistoryTimer = 0;
  const videoElements = new Map();

  function freshProject() {
    return { version:9, fps:30, resolution:1080, aspect:'16:9', playhead:0, inPoint:null, outPoint:null, sequenceDuration:null, timelineDisplay:'timecode', timelineZoom:90, timelineHeight:286, inspectorWidth:DEFAULT_INSPECTOR_WIDTH, timelineSnap:true, timecode:false, counterMode:'timecode', previewQuality:'full', background:'#000000', videoTracks:1, audioTracks:0, videoTrackHeights:[DEFAULT_TRACK_HEIGHT], videoTrackEnabled:[true], videoTrackLocked:[false], audioTrackHeights:[], audioTrackMuted:[], audioTrackSolo:[], audioTrackLocked:[], textTrackLocked:false, clips:[], texts:[], audio:[] };
  }

  function notify(message) {
    const el = $('#anToast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  function cloneProjectForHistory(source=project) {
    return {
      ...source,
      videoTrackHeights:[...(source.videoTrackHeights||[])],
      videoTrackEnabled:[...(source.videoTrackEnabled||[])],
      videoTrackLocked:[...(source.videoTrackLocked||[])],
      audioTrackHeights:[...(source.audioTrackHeights||[])],
      audioTrackMuted:[...(source.audioTrackMuted||[])],
      audioTrackSolo:[...(source.audioTrackSolo||[])],
      audioTrackLocked:[...(source.audioTrackLocked||[])],
      clips:source.clips.map(clip=>({...clip,framing:{...(clip.framing||{})},strokes:structuredClone(clip.strokes||[])})),
      texts:source.texts.map(text=>({...text})),
      audio:source.audio.map(audio=>({...audio})),
    };
  }

  function captureHistoryState() {
    return {project:cloneProjectForHistory(),selection:[...selectedTimelineIds],primaryId:primarySelectionId()};
  }

  function historyFingerprint(state) {
    const p=state.project;
    return JSON.stringify({
      ...p,
      playhead:0,
      clips:p.clips.map(({blob,url,...clip})=>clip),
      audio:p.audio.map(({blob,url,...audio})=>audio),
    });
  }

  const timelineHistory=createTimelineHistory({limit:HISTORY_LIMIT,clone:state=>({project:cloneProjectForHistory(state.project),selection:[...(state.selection||[])],primaryId:state.primaryId||null}),fingerprint:historyFingerprint});

  function rememberMedia(entry){if(entry?.mediaId&&(entry.blob||entry.url))mediaResources.set(entry.mediaId,{blob:entry.blob||null,url:entry.url||null});}
  function rememberProjectMedia(source=project){for(const entry of [...source.audio,...source.clips.filter(isVideoClip)])rememberMedia(entry);}

  function historyMediaIds(){
    const ids=new Set();
    for(const state of timelineHistory.states())for(const entry of [...state.project.audio,...state.project.clips.filter(isVideoClip)])if(entry.mediaId)ids.add(entry.mediaId);
    for(const entry of timelineClipboard?.entries||[])if(entry.item?.mediaId)ids.add(entry.item.mediaId);
    return ids;
  }

  function pruneMediaResources(){
    const used=historyMediaIds();
    for(const [mediaId,resource] of mediaResources){if(used.has(mediaId))continue;if(resource.url)URL.revokeObjectURL(resource.url);mediaResources.delete(mediaId);audioWaveformCache.delete(mediaId);audioWaveformJobs.delete(mediaId);}
  }

  function resetAnimaticsHistory(){rememberProjectMedia();timelineHistory.reset(captureHistoryState());pruneMediaResources();}

  function markDirty() {
    rememberProjectMedia();timelineHistory.commit(captureHistoryState());pruneMediaResources();
    onDirty();
  }

  function deferMarkDirty(delay=260){clearTimeout(deferredHistoryTimer);deferredHistoryTimer=setTimeout(()=>{deferredHistoryTimer=0;markDirty();},delay);}
  function flushDeferredHistory(){if(!deferredHistoryTimer)return;clearTimeout(deferredHistoryTimer);deferredHistoryTimer=0;markDirty();}

  function applyHistoryState(state,label){
    if(!state)return false;
    if(playing)setPlaying(false);stopAudioPlayback();releaseVideoElements();
    clearActiveDrawingSession();activeStroke=null;project=cloneProjectForHistory(state.project);drawingOverlayCache.clear();
    for(const entry of [...project.audio,...project.clips.filter(isVideoClip)]){const resource=mediaResources.get(entry.mediaId);if(resource){entry.blob=resource.blob;entry.url=resource.url;}}
    syncActiveTrackTargets();
    setTimelineSelection(state.selection||[],state.primaryId);renderAll();pruneMediaResources();onDirty();notify(label);return true;
  }

  function undoAnimatics(){
    if(inlineTextId)finishInlineTextEdit(false);flushDeferredHistory();
    const state=timelineHistory.undo();if(!state){notify('Nothing to undo');return false;}return applyHistoryState(state,'Undo');
  }

  function redoAnimatics(){
    if(inlineTextId)finishInlineTextEdit(false);flushDeferredHistory();
    const state=timelineHistory.redo();if(!state){notify('Nothing to redo');return false;}return applyHistoryState(state,'Redo');
  }

  resetAnimaticsHistory();

  function contentDuration(source=project) {
    return Math.max(0, ...source.clips.map(c => c.start + c.duration), ...source.texts.map(c => c.start + c.duration), ...source.audio.map(c => c.start + c.duration));
  }

  function fixedSequenceEnd(){return Number.isFinite(project.sequenceDuration)?project.sequenceDuration:null;}

  function automaticSequenceEnd(){return automaticTimelineDuration(contentDuration());}

  function duration() { return fixedSequenceEnd() ?? automaticSequenceEnd(); }

  function durationWithinSequence(start, requested, maximum=600){
    const limit=fixedSequenceEnd(),available=limit===null?maximum:Math.max(0,limit-start);
    if(available<MIN_SHOT_SECONDS)return 0;
    return clamp(requested,MIN_SHOT_SECONDS,Math.min(maximum,available));
  }

  function selectedClip() {
    return project.clips.find(c => c.id === selectedClipId) || null;
  }

  function selectedText() {
    return project.texts.find(c => c.id === selectedTextId) || null;
  }

  function entryById(id) {
    let item=project.clips.find(c=>c.id===id);if(item)return {item,kind:'video',collection:project.clips};
    item=project.texts.find(c=>c.id===id);if(item)return {item,kind:'text',collection:project.texts};
    item=project.audio.find(c=>c.id===id);return item?{item,kind:'audio',collection:project.audio}:null;
  }

  function timelineEntries(){
    return [
      ...project.clips.map(item=>({item,kind:'video',collection:project.clips})),
      ...project.texts.map(item=>({item,kind:'text',collection:project.texts})),
      ...project.audio.map(item=>({item,kind:'audio',collection:project.audio})),
    ];
  }

  function syncPrimarySelection(primaryId=null) {
    if(primaryId&&!selectedTimelineIds.has(primaryId))primaryId=null;
    const entry=entryById(primaryId||selectedTimelineIds.values().next().value);
    selectedClipId=entry?.kind==='video'?entry.item.id:null;
    selectedTextId=entry?.kind==='text'?entry.item.id:null;
    selectedAudioId=entry?.kind==='audio'?entry.item.id:null;
  }

  function setTimelineSelection(ids,primaryId=null) {
    selectedGap=null;
    selectedTimelineIds=new Set([...ids].filter(id=>{const entry=entryById(id);return entry&&!isEntryLocked(entry);}));
    syncPrimarySelection(primaryId);
  }

  function selectTimelineEntry(id,{add=false,toggle=false}={}) {
    const next=add||toggle?new Set(selectedTimelineIds):new Set();
    if(toggle&&next.has(id))next.delete(id);else next.add(id);
    setTimelineSelection(next,next.has(id)?id:null);
  }

  function primarySelectionId(){return selectedClipId||selectedTextId||selectedAudioId||null;}

  function selectedEntries(kind=null) {
    return [...selectedTimelineIds].map(entryById).filter(entry=>entry&&(!kind||entry.kind===kind));
  }

  function selectedVisualClips(){return selectedEntries('video').map(entry=>entry.item);}
  function selectedAudioClips(){return selectedEntries('audio').map(entry=>entry.item);}
  function selectedDurationItems(){return selectedEntries().filter(entry=>entry.kind==='video'||entry.kind==='audio').map(entry=>entry.item);}
  function timelineMediaItems(){return [...project.clips,...project.audio];}
  function timelineMediaEdgeTimes(excludeIds=[]){
    const excluded=new Set(excludeIds);return timelineMediaItems().filter(item=>!excluded.has(item.id)).flatMap(item=>[Number(item.start),Number(item.start)+Number(item.duration)]).filter(Number.isFinite);
  }

  function parseDrawHex(value){const match=String(value||'').trim().match(/^#?([0-9a-f]{6})$/i);if(!match)return null;const n=parseInt(match[1],16);return {r:n>>16,g:n>>8&255,b:n&255,hex:`#${match[1].toLowerCase()}`};}
  function rgbToDrawHsv({r,g,b}){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;if(d){if(max===r)h=60*(((g-b)/d)%6);else if(max===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4);}if(h<0)h+=360;return {h,s:max?d/max:0,v:max};}
  function drawHsvToHex(h,s,v){const c=v*s,x=c*(1-Math.abs(h/60%2-1)),m=v-c;let r=0,g=0,b=0;if(h<60){r=c;g=x;}else if(h<120){r=x;g=c;}else if(h<180){g=c;b=x;}else if(h<240){g=x;b=c;}else if(h<300){r=x;b=c;}else{r=c;b=x;}return `#${[r,g,b].map(channel=>Math.round((channel+m)*255).toString(16).padStart(2,'0')).join('')}`;}
  function applyDrawColor(value){const parsed=parseDrawHex(value);if(!parsed)return false;drawColor=parsed.hex;const hsv=rgbToDrawHsv(parsed);drawColorH=hsv.h;drawColorS=hsv.s;drawColorV=hsv.v;syncDrawColorUi();syncDrawUi();return true;}
  function syncDrawColorUi(){
    const color=drawHsvToHex(drawColorH,drawColorS,drawColorV);drawColor=color;const sv=$('#anDrawCpSv'),dot=$('#anDrawCpDot'),hue=$('#anDrawCpHue'),preview=$('#anDrawCpPreview'),hex=$('#anDrawCpHex');if(sv)sv.style.background=`hsl(${drawColorH},100%,50%)`;if(dot){dot.style.left=`${drawColorS*100}%`;dot.style.top=`${(1-drawColorV)*100}%`;}if(hue)hue.value=String(Math.round(drawColorH));if(preview)preview.style.background=color;if(hex&&document.activeElement!==hex)hex.value=color;root.querySelectorAll('[data-an-draw-color]').forEach(button=>button.classList.toggle('on',button.dataset.anDrawColor===color));
  }
  function syncTextColorUi(){
    const color=drawHsvToHex(textColorH,textColorS,textColorV),sv=$('#anTextCpSv'),dot=$('#anTextCpDot'),hue=$('#anTextCpHue'),preview=$('#anTextCpPreview'),hex=$('#anTextCpHex'),swatch=$('#anTextColorSwatch');if(sv)sv.style.background=`hsl(${textColorH},100%,50%)`;if(dot){dot.style.left=`${textColorS*100}%`;dot.style.top=`${(1-textColorV)*100}%`;}if(hue)hue.value=String(Math.round(textColorH));if(preview)preview.style.background=color;if(swatch)swatch.style.background=color;if(hex&&document.activeElement!==hex)hex.value=color;root.querySelectorAll('[data-an-text-color]').forEach(button=>button.classList.toggle('on',button.dataset.anTextColor===color));
  }
  function dispatchTextColor(commit=false){const input=$('#anTextColor');input.dispatchEvent(new Event('input',{bubbles:true}));if(commit)input.dispatchEvent(new Event('change',{bubbles:true}));}
  function applyTextColor(value,{emit=false,commit=false}={}){const parsed=parseDrawHex(value);if(!parsed)return false;const hsv=rgbToDrawHsv(parsed);textColorH=hsv.h;textColorS=hsv.s;textColorV=hsv.v;$('#anTextColor').value=parsed.hex;syncTextColorUi();if(emit)dispatchTextColor(commit);return true;}
  function applyTextColorHsv({commit=false}={}){$('#anTextColor').value=drawHsvToHex(textColorH,textColorS,textColorV);syncTextColorUi();dispatchTextColor(commit);}
  function setTextColorOpen(on){textColorOpen=!!on;$('#anTextColorPop').classList.toggle('open',textColorOpen);$('#anTextColorPop').setAttribute('aria-hidden',String(!textColorOpen));$('#anTextColorButton').classList.toggle('open',textColorOpen);$('#anTextColorButton').setAttribute('aria-expanded',String(textColorOpen));if(textColorOpen){closeAnimaticsSelectMenus();drawColorOpen=false;drawBrushesOpen=false;drawWidthMenuOpen=false;syncDrawUi();}}
  function positionDrawWidthMenu(){if(!drawWidthMenuOpen)return;const trigger=$('#anDrawWidthMenuButton'),menu=$('#anDrawWidthMenu');if(!trigger||!menu)return;const rect=trigger.getBoundingClientRect(),gap=4,margin=6,desired=Math.min(286,menu.scrollHeight||286),below=Math.max(0,window.innerHeight-rect.bottom-gap-margin),above=Math.max(0,rect.top-gap-margin),opensUp=below<desired&&above>below,available=Math.max(80,opensUp?above:below);menu.style.maxHeight=`${Math.min(desired,available)}px`;const height=Math.min(menu.scrollHeight||desired,available),top=opensUp?Math.max(margin,rect.top-gap-height):Math.min(window.innerHeight-margin-height,rect.bottom+gap),left=clamp(rect.right-menu.offsetWidth,margin,Math.max(margin,window.innerWidth-menu.offsetWidth-margin));menu.style.left=`${Math.round(left)}px`;menu.style.top=`${Math.round(top)}px`;menu.dataset.placement=opensUp?'up':'down';}
  function setDrawColorOpen(on){drawColorOpen=!!on;$('#anDrawColorPop').classList.toggle('open',drawColorOpen);$('#anDrawColorPop').setAttribute('aria-hidden',String(!drawColorOpen));$('#anDrawColorButton').classList.toggle('open',drawColorOpen);$('#anDrawColorButton').setAttribute('aria-expanded',String(drawColorOpen));if(drawColorOpen){setTextColorOpen(false);drawBrushesOpen=false;drawWidthMenuOpen=false;syncDrawUi();}}
  function setDrawBrushesOpen(on){drawBrushesOpen=!!on;if(drawBrushesOpen){drawColorOpen=false;drawWidthMenuOpen=false;}syncDrawUi();}
  function setDrawWidthMenuOpen(on){drawWidthMenuOpen=!!on;if(drawWidthMenuOpen){drawBrushesOpen=false;drawColorOpen=false;}syncDrawUi();if(drawWidthMenuOpen)positionDrawWidthMenu();}
  function drawingTargetClip(){const visible=clipsAt(project.playhead),selected=selectedClip();return visible.find(clip=>clip.id===selected?.id)||visible.at(-1)||null;}
  function validateDrawingTarget({select=true}={}){const clip=drawingTargetClip();if(!clip){notify('Move the playhead over a visible clip first');return null;}if(isTrackLocked('video',Number(clip.track)||0)){notify(`V${(Number(clip.track)||0)+1} is locked`);return null;}if(select&&clip.id!==selectedClipId)setTimelineSelection([clip.id],clip.id);return clip;}
  function hideDrawSizePreview(){clearTimeout(drawSizePreviewTimer);drawSizePreviewTimer=0;$('#anDrawSizePreview').classList.remove('show');}
  function positionDrawSizePreview(){const preview=$('#anDrawSizePreview'),rect=canvas.getBoundingClientRect(),brushMul=drawTool==='pen'?(DRAW_BRUSHES[drawBrushType]?.widthMul||1):1,diameter=clamp(drawWidth*brushMul*rect.width/1280,6,180);preview.style.left=`${drawPointer.x*100}%`;preview.style.top=`${drawPointer.y*100}%`;preview.style.width=`${diameter}px`;preview.style.height=`${diameter}px`;preview.dataset.tool=drawTool;}
  function showDrawSizePreview(){if(!drawMode||!drawPointer.inside)return;positionDrawSizePreview();$('#anDrawSizePreview').classList.add('show');clearTimeout(drawSizePreviewTimer);drawSizePreviewTimer=setTimeout(hideDrawSizePreview,620);}
  function setDrawWidth(value,{preview=false}={}){const numeric=Number(value);if(!Number.isFinite(numeric))return false;drawWidth=clamp(Math.round(numeric),DRAW_WIDTH_MIN,DRAW_WIDTH_MAX);drawToolWidths[drawTool]=drawWidth;syncDrawUi();if(preview)showDrawSizePreview();return true;}
  function adjustDrawWidth(delta,{preview=false}={}){setDrawWidth(drawWidth+delta,{preview});}
  function setDrawTool(tool){if(!['pen','eraser'].includes(tool))return;drawTool=tool;drawWidth=drawToolWidths[tool];drawWidthMenuOpen=false;if(tool==='eraser'){drawBrushesOpen=false;setDrawColorOpen(false);}syncDrawUi();}
  function setDrawBrush(type){if(!DRAW_BRUSHES[type])return;drawBrushType=type;drawTool='pen';drawWidth=drawToolWidths.pen;syncDrawUi();}
  function setDrawMode(on){if(on&&!validateDrawingTarget())return false;if(!on&&activeStroke)finishActiveDrawing();drawMode=!!on;if(drawMode){framingMode=false;setPlaying(false);showDrawSizePreview();}else{clearActiveDrawingSession();hideDrawSizePreview();}syncDrawUi();syncInspector();canvas.style.cursor=drawMode?'crosshair':'default';return true;}
  function syncDrawUi(){
    $('#anDrawToggle').classList.toggle('on',drawMode);$('#anDrawToggle').textContent=drawMode?'Stop drawing (D)':'Start drawing (D)';$('#anDrawPen').classList.toggle('on',drawTool==='pen');$('#anDrawEraser').classList.toggle('on',drawTool==='eraser');$('#anDrawBrushes').classList.toggle('open',drawBrushesOpen);$('#anDrawPen').setAttribute('aria-expanded',String(drawBrushesOpen));root.querySelectorAll('[data-an-brush]').forEach(button=>button.classList.toggle('on',button.dataset.anBrush===drawBrushType&&drawTool==='pen'));$('#anDrawColorPop').classList.toggle('open',drawColorOpen);$('#anDrawColorPop').setAttribute('aria-hidden',String(!drawColorOpen));$('#anDrawColorButton').classList.toggle('open',drawColorOpen);$('#anDrawColorButton').setAttribute('aria-expanded',String(drawColorOpen));$('#anDrawColorSwatch').style.background=drawColor;const widthInput=$('#anDrawWidthVal');if(document.activeElement!==widthInput)widthInput.value=String(drawWidth);$('#anDrawWidthMenu').classList.toggle('open',drawWidthMenuOpen);$('#anDrawWidthMenuButton').classList.toggle('open',drawWidthMenuOpen);$('#anDrawWidthMenuButton').setAttribute('aria-expanded',String(drawWidthMenuOpen));root.querySelectorAll('[data-an-draw-width]').forEach(button=>{const selected=Number(button.dataset.anDrawWidth)===drawWidth;button.classList.toggle('on',selected);button.setAttribute('aria-selected',String(selected));});const target=drawingTargetClip(),locked=target&&isTrackLocked('video',Number(target.track)||0);$('#anClearDraw').disabled=!target||locked||!target.strokes?.length;syncDrawColorUi();
  }

  function clearActiveDrawingSession(){if(activeDrawingRaf)cancelAnimationFrame(activeDrawingRaf);activeDrawingRaf=0;activeDrawingClipId=null;activeDrawingOverlay=null;activeDrawingStrokeCanvas=null;}
  function prepareActiveDrawing(clip){clearActiveDrawingSession();activeDrawingClipId=clip.id;activeDrawingOverlay=document.createElement('canvas');activeDrawingOverlay.width=canvas.width;activeDrawingOverlay.height=canvas.height;activeDrawingOverlay.getContext('2d').drawImage(drawingOverlayForClip(clip,canvas.width,canvas.height),0,0);activeDrawingStrokeCanvas=document.createElement('canvas');activeDrawingStrokeCanvas.width=canvas.width;activeDrawingStrokeCanvas.height=canvas.height;}
  function appendActiveDrawingSegment(from,to){if(!activeStroke||!activeDrawingOverlay)return;const destination=activeStroke.tool==='eraser'?activeDrawingOverlay:activeDrawingStrokeCanvas;drawDrawingSegment(destination.getContext('2d'),activeStroke,from,to,destination.width,destination.height,{opaquePen:true});}
  function scheduleActiveDrawingPaint(){if(activeDrawingRaf)return;activeDrawingRaf=requestAnimationFrame(()=>{activeDrawingRaf=0;if(activeStroke)drawViewerLive();});}
  function finishActiveDrawing(){if(!activeStroke)return false;const clip=project.clips.find(item=>item.id===activeDrawingClipId);if(clip&&activeDrawingOverlay){if(activeStroke.tool!=='eraser'&&activeDrawingStrokeCanvas){const brush=DRAW_BRUSHES[activeStroke.brush]||DRAW_BRUSHES.pen,g=activeDrawingOverlay.getContext('2d');g.save();g.globalAlpha=brush.alpha;g.drawImage(activeDrawingStrokeCanvas,0,0);g.restore();}rememberDrawingOverlay(clip,activeDrawingOverlay);}activeStroke=null;clearActiveDrawingSession();drawViewerLive();markDirty();syncDrawUi();renderTimeline();return true;}

  function normalizedTrackHeights(values,count){return Array.from({length:count},(_,index)=>clamp(Number(values?.[index])||DEFAULT_TRACK_HEIGHT,MIN_TRACK_HEIGHT,MAX_TRACK_HEIGHT));}
  function normalizedTrackEnabled(values,count){return Array.from({length:count},(_,index)=>values?.[index]!==false);}
  function normalizedTrackFlags(values,count){return Array.from({length:count},(_,index)=>values?.[index]===true);}
  function ensureTrackHeightCounts(){project.videoTrackHeights=normalizedTrackHeights(project.videoTrackHeights,project.videoTracks);project.videoTrackEnabled=normalizedTrackEnabled(project.videoTrackEnabled,project.videoTracks);project.videoTrackLocked=normalizedTrackFlags(project.videoTrackLocked,project.videoTracks);project.audioTrackHeights=normalizedTrackHeights(project.audioTrackHeights,project.audioTracks);project.audioTrackMuted=normalizedTrackFlags(project.audioTrackMuted,project.audioTracks);project.audioTrackSolo=normalizedTrackFlags(project.audioTrackSolo,project.audioTracks);project.audioTrackLocked=normalizedTrackFlags(project.audioTrackLocked,project.audioTracks);project.textTrackLocked=project.textTrackLocked===true;}
  function trackHeights(kind){return kind==='audio'?project.audioTrackHeights:project.videoTrackHeights;}
  function trackHeight(kind,track){return clamp(Number(trackHeights(kind)?.[track])||DEFAULT_TRACK_HEIGHT,MIN_TRACK_HEIGHT,MAX_TRACK_HEIGHT);}
  function setTrackHeight(kind,track,height){ensureTrackHeightCounts();trackHeights(kind)[track]=clamp(height,MIN_TRACK_HEIGHT,MAX_TRACK_HEIGHT);}
  function syncActiveTrackTargets(){activeVideoTrack=clamp(Math.round(Number(activeVideoTrack)||0),0,Math.max(0,project.videoTracks-1));activeAudioTrack=clamp(Math.round(Number(activeAudioTrack)||0),0,Math.max(0,project.audioTracks-1));}
  function reorderedTrackTarget(active,from,to){if(active===from)return to;if(from<to&&active>from&&active<=to)return active-1;if(from>to&&active>=to&&active<from)return active+1;return active;}
  function setActiveTimelineTrack(kind,track){
    const count=kind==='audio'?project.audioTracks:project.videoTracks;if(!Number.isInteger(track)||track<0||track>=count)return false;
    if(isTrackLocked(kind,track)){notify(`${kind==='audio'?'A':'V'}${track+1} is locked`);return false;}
    if(kind==='audio')activeAudioTrack=track;else activeVideoTrack=track;renderTimeline();notify(`${kind==='audio'?'A':'V'}${track+1} paste target active`);return true;
  }
  function isVideoTrackEnabled(track){return project.videoTrackEnabled?.[track]!==false;}
  function isTrackLocked(kind,track=0){return kind==='text'?project.textTrackLocked===true:kind==='audio'?project.audioTrackLocked?.[track]===true:project.videoTrackLocked?.[track]===true;}
  function isEntryLocked(entry){return !!entry&&isTrackLocked(entry.kind,Number(entry.item?.track)||0);}
  function hasSoloAudioTrack(){return project.audioTrackSolo?.some(Boolean)===true;}
  function isAudioTrackAudible(track){return project.audioTrackMuted?.[track]!==true&&(!hasSoloAudioTrack()||project.audioTrackSolo?.[track]===true);}
  function effectiveAudioVolume(clip){return isAudioTrackAudible(Number(clip?.track)||0)?clamp(Number.isFinite(Number(clip?.volume))?Number(clip.volume):1,0,MAX_AUDIO_GAIN):0;}
  function previewAudioVolume(clip){return previewMuted?0:effectiveAudioVolume(clip);}
  function isVisualClipEnabled(clip){return clip?.enabled!==false;}
  function isVisualClipVisible(clip){return isVisualClipEnabled(clip)&&isVideoTrackEnabled(Number(clip?.track)||0);}

  function moveTimelineTrack(kind,from,to){
    const video=kind==='video',count=video?project.videoTracks:project.audioTracks;if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<0||from>=count||to>=count||from===to)return false;
    const first=Math.min(from,to),last=Math.max(from,to);for(let track=first;track<=last;track++)if(isTrackLocked(kind,track)){notify('Unlock affected tracks before reordering');return false;}
    if(video)project.clips=reorderTimelineTracks(project.clips,from,to);else project.audio=reorderTimelineTracks(project.audio,from,to);
    ensureTrackHeightCounts();const heights=trackHeights(kind),[height]=heights.splice(from,1);heights.splice(to,0,height);if(video){const [enabled]=project.videoTrackEnabled.splice(from,1),[locked]=project.videoTrackLocked.splice(from,1);project.videoTrackEnabled.splice(to,0,enabled!==false);project.videoTrackLocked.splice(to,0,locked===true);activeVideoTrack=reorderedTrackTarget(activeVideoTrack,from,to);}else{for(const values of [project.audioTrackMuted,project.audioTrackSolo,project.audioTrackLocked]){const [value]=values.splice(from,1);values.splice(to,0,value===true);}activeAudioTrack=reorderedTrackTarget(activeAudioTrack,from,to);}return true;
  }

  function replaceTimelineMediaItems(items){
    const byId=new Map((items||[]).map(item=>[item.id,item]));
    project.clips=project.clips.map(item=>byId.get(item.id)||item);
    project.audio=project.audio.map(item=>byId.get(item.id)||item);
  }

  function cleanupTimelineLinks(){replaceTimelineMediaItems(normalizeTimelineLinks(timelineMediaItems()));}

  function uniformValue(items,getValue,tolerance=1e-8){
    if(!items.length)return null;const first=getValue(items[0]);
    return items.every(item=>Math.abs(getValue(item)-first)<=tolerance)?first:null;
  }
  function uniformExactValue(items,getValue){if(!items.length)return null;const first=getValue(items[0]);return items.every(item=>getValue(item)===first)?first:null;}

  function syncLinkButton(){
    const button=$('#anLink');if(!button)return;
    const entries=selectedEntries().filter(entry=>entry.kind==='video'||entry.kind==='audio'),groups=new Set(entries.map(entry=>entry.item.linkGroupId).filter(Boolean));
    const unlink=groups.size===1&&entries.length>0&&entries.every(entry=>entry.item.linkGroupId===[...groups][0]);
    button.disabled=!unlink&&entries.length<2;button.classList.toggle('link-active',unlink);button.setAttribute('aria-pressed',String(unlink));
    button.title=unlink?'Unlink selected clips (Ctrl+L)':'Link selected clips (Ctrl+L)';button.setAttribute('aria-label',unlink?'Unlink selected clips':'Link selected clips');
  }

  function toggleLinkSelection(){
    const entries=selectedEntries().filter(entry=>entry.kind==='video'||entry.kind==='audio'),ids=entries.map(entry=>entry.item.id),groups=new Set(entries.map(entry=>entry.item.linkGroupId).filter(Boolean));
    const unlink=groups.size===1&&entries.length>0&&entries.every(entry=>entry.item.linkGroupId===[...groups][0]);
    const affected=unlink?linkedTimelineIds(timelineMediaItems(),ids):new Set(ids);if([...affected].map(entryById).filter(Boolean).some(isEntryLocked)){notify('Unlock every affected track before changing links');return;}
    if(unlink){replaceTimelineMediaItems(unlinkTimelineItems(timelineMediaItems(),ids));markDirty();renderAll();notify(ids.length===1?'Clip unlinked':`${ids.length} clips unlinked`);return;}
    if(entries.length<2){notify('Select at least two image, video, or audio clips');return;}
    const overlapStart=Math.max(...entries.map(entry=>entry.item.start)),overlapEnd=Math.min(...entries.map(entry=>entry.item.start+entry.item.duration));
    if(overlapEnd-overlapStart<1/project.fps-1e-8){notify('Linked clips need to overlap in time');return;}
    replaceTimelineMediaItems(linkTimelineItems(timelineMediaItems(),ids,uid()));markDirty();renderAll();notify(`${ids.length} clips linked`);
  }

  function refreshVisibleVideoPlayback(){if(!playing)return;stopVideoPlayback();startVideoPlayback();}

  function toggleSelectedVisualVisibility(){
    const clips=selectedVisualClips();if(!clips.length){notify('Select one or more image or video clips');return false;}
    const enable=clips.every(clip=>!isVisualClipEnabled(clip));for(const clip of clips)clip.enabled=enable;
    refreshVisibleVideoPlayback();markDirty();renderAll();notify(`${clips.length} visual clip${clips.length===1?'':'s'} ${enable?'enabled':'disabled'}`);return true;
  }

  function toggleVideoTrackVisibility(track){
    if(!Number.isInteger(track)||track<0||track>=project.videoTracks)return false;ensureTrackHeightCounts();project.videoTrackEnabled[track]=!isVideoTrackEnabled(track);
    const enabled=isVideoTrackEnabled(track);refreshVisibleVideoPlayback();markDirty();renderAll();notify(`V${track+1} ${enabled?'enabled':'disabled'}`);return true;
  }

  function toggleTrackLock(kind,track=0){
    ensureTrackHeightCounts();const label=kind==='text'?'T1':`${kind==='audio'?'A':'V'}${track+1}`;
    if(kind==='text')project.textTrackLocked=!project.textTrackLocked;
    else{const values=kind==='audio'?project.audioTrackLocked:project.videoTrackLocked;if(!Number.isInteger(track)||track<0||track>=values.length)return false;values[track]=!values[track];}
    const locked=isTrackLocked(kind,track);if(locked)setTimelineSelection([...selectedTimelineIds].filter(id=>{const entry=entryById(id);return entry&&!isEntryLocked(entry);}),primarySelectionId());
    markDirty();renderAll();notify(`${label} ${locked?'locked':'unlocked'}`);return true;
  }

  function toggleAudioTrackState(track,state){
    if(!Number.isInteger(track)||track<0||track>=project.audioTracks)return false;ensureTrackHeightCounts();const values=state==='solo'?project.audioTrackSolo:project.audioTrackMuted;values[track]=!values[track];
    if(playing)startAudioPlayback();markDirty();renderTimeline();notify(`A${track+1} ${values[track]?(state==='solo'?'soloed':'muted'):(state==='solo'?'solo off':'unmuted')}`);return true;
  }

  function applyNormalizedAudioFades(clip){const fades=normalizedAudioFades(clip);Object.assign(clip,fades);return fades;}

  function gainTargets(){
    const selected=selectedAudioClips();if(selected.length)return selected;
    return project.audio.filter(item=>item.track===activeAudioTrack&&!isTrackLocked('audio',activeAudioTrack));
  }

  function openAudioGainDialog(){
    const clips=gainTargets();if(!clips.length){notify('Select audio clips or activate an audio track');return false;}gainDialogIds=clips.map(item=>item.id);const value=uniformValue(clips,item=>gainToDb(item.volume??1),.001);$('#anGainMode').value='set';$('#anGainDb').value=String(Number((value??0).toFixed(2)));$('#anGainCurrent').textContent=value===null?'Current gain: Mixed':`Current gain ${value>=0?'+':''}${value.toFixed(2)} dB`;$('#anGainScope').textContent=`${clips.length} audio clip${clips.length===1?'':'s'} · ${selectedAudioClips().length?'selection':`A${activeAudioTrack+1}`}`;$('#anGainModal').classList.add('open');requestAnimationFrame(()=>{$('#anGainDb').focus();$('#anGainDb').select();});return true;
  }

  function closeAudioGainDialog(){gainDialogIds=[];$('#anGainModal').classList.remove('open');}

  function applyAudioGainDialog(){
    const clips=gainDialogIds.map(id=>project.audio.find(item=>item.id===id)).filter(item=>item&&!isTrackLocked('audio',item.track)),mode=$('#anGainMode').value,value=clamp(Number($('#anGainDb').value)||0,MIN_AUDIO_DB,MAX_AUDIO_DB);if(!clips.length){closeAudioGainDialog();return;}
    for(const clip of clips){clip.volume=mode==='adjust'?clamp((clip.volume??1)*dbToGain(value),0,MAX_AUDIO_GAIN):dbToGain(value);updateActiveAudioGain(clip);}markDirty();closeAudioGainDialog();renderAll();notify(`Applied ${value>=0?'+':''}${value.toFixed(1)} dB to ${clips.length} clip${clips.length===1?'':'s'}`);
  }

  function applySelectedFadeSetting(side,key,value,{commit=true}={}){
    const clips=selectedAudioClips();if(!clips.length)return false;for(const clip of clips){clip[`fade${side}${key}`]=value;applyNormalizedAudioFades(clip);updateActiveAudioGain(clip);}if(commit)markDirty();renderTimeline();syncInspector();return true;
  }

  function isVideoClip(clip) {
    return clip?.mediaKind === 'video';
  }

  function isVideoFile(file){return String(file?.type||'').startsWith('video/')||/\.(mp4|mov|m4v|webm|avi|mkv|mpeg|mpg|ogv)$/i.test(String(file?.name||''));}
  function isImageFile(file){return String(file?.type||'').startsWith('image/')||/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(String(file?.name||''));}
  function isAudioFile(file){return String(file?.type||'').startsWith('audio/')||/\.(wav|mp3|m4a|aac|ogg|flac|opus|wma)$/i.test(String(file?.name||''));}
  function droppedFileKind(file){return isImageFile(file)?'image':isVideoFile(file)?'video':isAudioFile(file)?'audio':null;}

  function hasSequenceRange() {
    return Number.isFinite(project.inPoint) && Number.isFinite(project.outPoint) && project.outPoint > project.inPoint + MIN_SHOT_SECONDS;
  }

  function clipsAt(t) {
    const videoEnd=Math.max(0,...project.clips.map(c=>c.start+c.duration));
    const sample=Math.abs(t-videoEnd)<1e-7&&videoEnd>0?Math.max(0,t-.5/project.fps):t;
    // Timeline rows are displayed V1, V2, ... from top to bottom. Paint the
    // lower rows first so the visually higher row remains the top layer.
    return project.clips.filter(c => isVisualClipVisible(c)&&sample >= c.start && sample < c.start + c.duration).sort((a,b) => b.track - a.track);
  }

  function normalizeProject(raw, mediaBlobs = new Map()) {
    const base = freshProject();
    if (!raw || typeof raw !== 'object') return base;
    base.fps = [24,30,60].includes(Number(raw.fps)) ? Number(raw.fps) : 30;
    base.resolution = [480,720,1080].includes(Number(raw.resolution)) ? Number(raw.resolution) : 1080;
    base.aspect = ASPECT_RATIOS[raw.aspect] ? raw.aspect : '16:9';
    base.inPoint = raw.inPoint!==null&&raw.inPoint!==''&&Number.isFinite(Number(raw.inPoint)) ? Math.max(0,Number(raw.inPoint)) : null;
    base.outPoint = raw.outPoint!==null&&raw.outPoint!==''&&Number.isFinite(Number(raw.outPoint)) ? Math.max(0,Number(raw.outPoint)) : null;
    if(Number.isFinite(base.inPoint)&&Number.isFinite(base.outPoint)&&base.outPoint<=base.inPoint+MIN_SHOT_SECONDS)base.outPoint=null;
    base.timelineHeight = clamp(Number(raw.timelineHeight)||286,180,620);
    base.inspectorWidth = clamp(Number(raw.inspectorWidth)||DEFAULT_INSPECTOR_WIDTH,MIN_INSPECTOR_WIDTH,MAX_INSPECTOR_WIDTH);
    base.timelineSnap = raw.timelineSnap !== false;
    base.sequenceDuration = Number.isFinite(Number(raw.sequenceDuration))&&Number(raw.sequenceDuration)>0 ? clamp(Number(raw.sequenceDuration),MIN_SHOT_SECONDS,MAX_SEQUENCE_SECONDS) : null;
    base.timelineDisplay = raw.timelineDisplay==='frames'?'frames':'timecode';
    base.timelineZoom = Number.isFinite(Number(raw.timelineZoom))&&Number(raw.timelineZoom)>0 ? clamp(Number(raw.timelineZoom),MIN_TIMELINE_ZOOM,MAX_TIMELINE_ZOOM) : Number.isFinite(base.sequenceDuration)?clamp(SAFE_INITIAL_TIMELINE_PIXELS/base.sequenceDuration,MIN_TIMELINE_ZOOM,90):90;
    base.timecode = !!raw.timecode;
    base.counterMode = ['timecode','frames','seconds'].includes(raw.counterMode) ? raw.counterMode : 'timecode';
    base.previewQuality = ['full','half','low'].includes(raw.previewQuality) ? raw.previewQuality : 'full';
    base.background = /^#[0-9a-f]{6}$/i.test(raw.background) ? raw.background : '#000000';
    base.videoTracks = clamp(Number(raw.videoTracks) || 1, 1, MAX_VIDEO_TRACKS);
    base.audioTracks = clamp(Number(raw.audioTracks) || 0, 0, MAX_AUDIO_TRACKS);
    base.clips = (Array.isArray(raw.clips) ? raw.clips : []).filter(c => c?.itemId || c?.mediaId).map(c => {
      const mediaKind=c.mediaKind==='video'||(!c.itemId&&c.mediaId)?'video':'image';
      const mediaId=mediaKind==='video'?String(c.mediaId||c.id||uid()):null;
      const blob=mediaId?mediaBlobs.get(mediaId)||null:null;
      const requestedDuration=clamp(Number(c.duration)||DEFAULT_SHOT_SECONDS,MIN_SHOT_SECONDS,600);
      const sourceIn=mediaKind==='video'?Math.max(0,Number(c.sourceIn)||0):0;
      const originalDuration=mediaKind==='video'?Math.max(sourceIn+requestedDuration,Number(c.originalDuration)||0,Number(c.sourceOut)||0):requestedDuration;
      const sourceOut=mediaKind==='video'?clamp(Number(c.sourceOut)||sourceIn+requestedDuration,sourceIn+MIN_SHOT_SECONDS,originalDuration):requestedDuration;
      const boardTransform=mediaKind==='image'?normalizeBoardTransform(c.boardTransform):null;
      return {
        id:String(c.id||uid()), itemId:mediaKind==='image'?String(c.itemId):null, mediaKind, mediaId,
        track:clamp(Number(c.track)||0,0,MAX_VIDEO_TRACKS-1), start:Math.max(0,Number(c.start)||0), duration:mediaKind==='video'?sourceOut-sourceIn:requestedDuration,
        sourceIn,sourceOut,originalDuration,name:String(c.name||(mediaKind==='video'?'Video':'Shot')),type:String(c.type||blob?.type||(mediaKind==='video'?'video/mp4':'image/png')),
        blob,url:blob?URL.createObjectURL(blob):null,needsRelink:mediaKind==='video'&&!blob,videoWidth:Math.max(0,Number(c.videoWidth)||0),videoHeight:Math.max(0,Number(c.videoHeight)||0),
        enabled:c.enabled!==false,
        framing:{fit:c.framing?.fit==='cover'?'cover':'contain',scale:clamp(Number(c.framing?.scale)||1,.01,8),x:clamp(Number(c.framing?.x)||0,-1,1),y:clamp(Number(c.framing?.y)||0,-1,1)},
        ...(boardTransform?{boardTransform,sourceAssetKey:String(c.sourceAssetKey||boardTransformAssetKey(c.itemId,boardTransform))}:{}),
        strokes:Array.isArray(c.strokes)?c.strokes.map(normalizeDrawingStroke):[],
        ...(typeof c.linkGroupId==='string'&&c.linkGroupId?{linkGroupId:c.linkGroupId}:{}),
      };
    });
    base.texts=(Array.isArray(raw.texts)?raw.texts:[]).map(t=>({
      id:String(t.id||uid()),track:0,start:Math.max(0,Number(t.start)||0),duration:clamp(Number(t.duration)||DEFAULT_SHOT_SECONDS,MIN_SHOT_SECONDS,600),
      content:String(t.content||''),size:clamp(Number(t.size)||42,8,300),color:/^#[0-9a-f]{6}$/i.test(t.color)?t.color:'#ffffff',
      fontFamily:normalizeTextFontFamily(t.fontFamily),bold:t.bold===true,italic:t.italic===true,align:normalizeTextAlign(t.align),background:t.background===true,
      scale:clamp(finiteOr(t.scale,1),.25,4),rotation:Math.round(clamp(finiteOr(t.rotation,0),-180,180)),x:clamp(finiteOr(t.x,.5),0,1),y:clamp(finiteOr(t.y,.82),0,1),
    })).filter(t=>t.content);
    for(const rawClip of Array.isArray(raw.clips)?raw.clips:[]){
      if(!rawClip?.text?.content)continue;
      const clip=base.clips.find(c=>c.id===String(rawClip.id));if(!clip)continue;
      base.texts.push({id:uid(),track:0,start:clip.start,duration:clip.duration,content:String(rawClip.text.content),size:clamp(Number(rawClip.text.size)||42,8,300),color:String(rawClip.text.color||'#ffffff'),fontFamily:DEFAULT_TEXT_FONT_FAMILY,bold:false,italic:false,align:'center',background:false,scale:1,rotation:0,x:.5,y:.82});
    }
    base.audio = (Array.isArray(raw.audio) ? raw.audio : []).map(a => {
      const mediaId = String(a.mediaId || a.id || uid());
      const blob = mediaBlobs.get(mediaId) || null;
      const sourceIn = clamp(Number(a.sourceIn) || 0, 0, Math.max(0, Number(a.originalDuration) || Number(a.sourceOut) || Number(a.duration) || 0));
      const requestedDuration = Math.max(MIN_SHOT_SECONDS, Number(a.duration) || MIN_SHOT_SECONDS);
      const originalDuration = Math.max(sourceIn + requestedDuration, Number(a.originalDuration) || 0, Number(a.sourceOut) || 0);
      const sourceOut = clamp(Number(a.sourceOut) || sourceIn + requestedDuration, sourceIn + MIN_SHOT_SECONDS, originalDuration);
      const fades=normalizedAudioFades({...a,duration:sourceOut-sourceIn});
      return {
        id:String(a.id || uid()), mediaId, track:clamp(Number(a.track)||0,0,MAX_AUDIO_TRACKS-1),
        start:Math.max(0,Number(a.start)||0), duration:sourceOut-sourceIn, sourceIn, sourceOut, originalDuration,
        name:String(a.name||'Audio'), volume:clamp(Number.isFinite(Number(a.volume))?Number(a.volume):1,0,MAX_AUDIO_GAIN), type:String(a.type||blob?.type||'audio/mpeg'),
        ...fades,
        blob, url:blob ? URL.createObjectURL(blob) : null, needsRelink:!blob,
        ...(typeof a.linkGroupId==='string'&&a.linkGroupId?{linkGroupId:a.linkGroupId}:{}),
      };
    });
    const normalizedLinks=normalizeTimelineLinks([...base.clips,...base.audio]),linkedById=new Map(normalizedLinks.map(item=>[item.id,item]));
    base.clips=base.clips.map(item=>linkedById.get(item.id)||item);base.audio=base.audio.map(item=>linkedById.get(item.id)||item);
    base.videoTracks=clamp(Math.max(base.videoTracks,1+Math.max(-1,...base.clips.map(c=>c.track))),1,MAX_VIDEO_TRACKS);
    base.audioTracks=clamp(Math.max(base.audioTracks,1+Math.max(-1,...base.audio.map(c=>c.track))),0,MAX_AUDIO_TRACKS);
    base.videoTrackHeights=normalizedTrackHeights(raw.videoTrackHeights,base.videoTracks);base.videoTrackEnabled=normalizedTrackEnabled(raw.videoTrackEnabled,base.videoTracks);base.videoTrackLocked=normalizedTrackFlags(raw.videoTrackLocked,base.videoTracks);base.audioTrackHeights=normalizedTrackHeights(raw.audioTrackHeights,base.audioTracks);base.audioTrackMuted=normalizedTrackFlags(raw.audioTrackMuted,base.audioTracks);base.audioTrackSolo=normalizedTrackFlags(raw.audioTrackSolo,base.audioTracks);base.audioTrackLocked=normalizedTrackFlags(raw.audioTrackLocked,base.audioTracks);base.textTrackLocked=raw.textTrackLocked===true&&base.texts.length>0;
    if(Number.isFinite(base.sequenceDuration))base.sequenceDuration=Math.max(base.sequenceDuration,contentDuration(base));
    return base;
  }

  function addItems(items, { append = true, track = 0, start = null } = {}) {
    const list = (items || []).filter(it => (it.kind || 'image') === 'image');
    if (!list.length) { notify('Select one or more images on the board first'); return false; }
    const targetTrack=clamp(Math.round(Number(track)||0),0,MAX_VIDEO_TRACKS-1);if(targetTrack<project.videoTracks&&isTrackLocked('video',targetTrack)){notify(`V${targetTrack+1} is locked`);return false;}project.videoTracks=Math.max(project.videoTracks,targetTrack+1);ensureTrackHeightCounts();
    const hasExplicitStart=start!==null&&start!==undefined&&Number.isFinite(Number(start));
    let cursor = hasExplicitStart?Math.max(0,Number(start)):append ? Math.max(0, ...project.clips.filter(c => c.track === targetTrack).map(c => c.start + c.duration)) : 0;
    const fixedBefore=fixedSequenceEnd(),requiredEnd=cursor+list.length*DEFAULT_SHOT_SECONDS,extendedEnd=fixedBefore!==null&&requiredEnd>fixedBefore?Math.min(MAX_SEQUENCE_SECONDS,Math.ceil(requiredEnd*project.fps)/project.fps):fixedBefore;
    if(extendedEnd!==null&&extendedEnd>fixedBefore)project.sequenceDuration=extendedEnd;
    const addedIds=[];
    for (const item of list) {
      const shotDuration=durationWithinSequence(cursor,DEFAULT_SHOT_SECONDS,DEFAULT_SHOT_SECONDS);if(!shotDuration)break;
      const boardTransform=normalizeBoardTransform(getBoardTransform(item));
      const clip={ id:uid(), itemId:item.id, mediaKind:'image', mediaId:null, track:targetTrack, start:cursor, duration:shotDuration, name:item.name || getImage(item.id)?.name || `Shot ${project.clips.length + 1}`, enabled:true, framing:{fit:'contain',scale:1,x:0,y:0}, ...(boardTransform?{boardTransform,sourceAssetKey:boardTransformAssetKey(item.id,boardTransform)}:{}), strokes:[] };
      project.clips.push(clip);addedIds.push(clip.id);
      cursor += shotDuration;
    }
    if(!addedIds.length){notify('The fixed sequence has no room for another shot');return false;}
    if(Number.isFinite(Number(start)))commitTimelineOverwrite(new Set(addedIds));
    activeVideoTrack=targetTrack;
    setTimelineSelection(addedIds,addedIds[0]);
    project.playhead = project.clips.find(c => c.id === selectedClipId)?.start || project.playhead;
    markDirty();
    renderAll();
    if(addedIds.length<list.length)notify(`Added ${addedIds.length}; the sequence reached its 24-hour limit`);
    else if(extendedEnd!==null&&extendedEnd>fixedBefore)notify(`Added ${addedIds.length} image${addedIds.length===1?'':'s'} · sequence extended to ${timecode(extendedEnd,project.fps)}`);
    return true;
  }

  function releaseVideoElements(){
    for(const video of videoElements.values()){video.pause();video.removeAttribute('src');video.load();}
    videoElements.clear();
  }

  function getVideoElement(clip){
    if(!isVideoClip(clip)||!clip.url)return null;
    let video=videoElements.get(clip.id);
    if(video&&video.dataset.source===clip.url)return video;
    if(video){video.pause();video.removeAttribute('src');video.load();}
    video=document.createElement('video');video.preload='auto';video.playsInline=true;video.muted=true;video.dataset.source=clip.url;video.src=clip.url;
    videoElements.set(clip.id,video);return video;
  }

  async function seekVideo(video,time){
    if(!video)return null;
    if(video.readyState<1)await new Promise(resolve=>{const done=()=>{video.removeEventListener('loadedmetadata',done);video.removeEventListener('error',done);resolve();};video.addEventListener('loadedmetadata',done,{once:true});video.addEventListener('error',done,{once:true});setTimeout(done,2500);});
    const duration=Number.isFinite(video.duration)?video.duration:Math.max(0,time);
    const target=clamp(time,0,Math.max(0,duration-.001));
    if(video.readyState>=2&&Math.abs(video.currentTime-target)<=1/project.fps)return video;
    await new Promise(resolve=>{let timer=0;const done=()=>{clearTimeout(timer);video.removeEventListener('seeked',done);video.removeEventListener('error',done);resolve();};video.addEventListener('seeked',done,{once:true});video.addEventListener('error',done,{once:true});timer=setTimeout(done,2500);try{video.currentTime=target;}catch{done();}});
    return video;
  }

  async function videoSourceAt(clip,t,exact=false){
    const video=getVideoElement(clip);if(!video)return null;
    const desired=(Number(clip.sourceIn)||0)+clamp(t-clip.start,0,clip.duration);
    if(exact||!playing)await seekVideo(video,desired);
    else if(video.readyState<2)await seekVideo(video,desired);
    if(!playing||exact)video.pause();
    return video.readyState>=2?video:null;
  }

  function stopVideoPlayback(){
    for(const timer of videoTimers)clearTimeout(timer);videoTimers=[];
    cancelAnimationFrame(videoCompositeRaf);videoCompositeRaf=0;
    for(const [video,callback] of videoFrameCallbacks){if(callback.native)video.cancelVideoFrameCallback?.(callback.id);else clearTimeout(callback.id);}videoFrameCallbacks.clear();
    for(const video of videoElements.values())video.pause();
  }

  function scheduleVideoFrameDraw(video){
    if(!playing||videoFrameCallbacks.has(video))return;
    const callback=()=>{videoFrameCallbacks.delete(video);if(!playing||video.paused)return;if(!videoCompositeRaf)videoCompositeRaf=requestAnimationFrame(()=>{videoCompositeRaf=0;if(playing)drawViewer();});scheduleVideoFrameDraw(video);};
    if(typeof video.requestVideoFrameCallback==='function'){const id=video.requestVideoFrameCallback(callback);videoFrameCallbacks.set(video,{id,native:true});}
    else{const id=setTimeout(callback,1000/30);videoFrameCallbacks.set(video,{id,native:false});}
  }

  function startVideoPlayback(){
    stopVideoPlayback();
    for(const clip of project.clips.filter(clip=>isVideoClip(clip)&&isVisualClipVisible(clip))){
      if(!clip.url||project.playhead>=clip.start+clip.duration)continue;
      const launch=async()=>{
        if(!playing)return;const video=getVideoElement(clip);if(!video)return;
        const offset=Math.max(0,project.playhead-clip.start),sourceIn=Number(clip.sourceIn)||0,sourceOut=Number(clip.sourceOut)||sourceIn+clip.duration;
        await seekVideo(video,sourceIn+offset);if(!playing)return;video.playbackRate=1;await video.play().catch(()=>{});scheduleVideoFrameDraw(video);
        videoTimers.push(setTimeout(()=>video.pause(),Math.max(0,(sourceOut-video.currentTime)*1000)+25));
      };
      const delay=Math.max(0,(clip.start-project.playhead)*1000);if(delay>0)videoTimers.push(setTimeout(launch,delay));else launch();
    }
  }

  async function addVideoFiles(files,{track=0,start=project.playhead}={}){
    const list=[...files].filter(isVideoFile);
    if(!list.length){notify('Drop one or more video files');return 0;}
    const targetTrack=clamp(Number(track)||0,0,MAX_VIDEO_TRACKS-1);if(targetTrack<project.videoTracks&&isTrackLocked('video',targetTrack)){notify(`V${targetTrack+1} is locked`);return 0;}activeVideoTrack=targetTrack;let cursor=Math.max(0,Number(start)||0),added=0;
    project.videoTracks=Math.max(project.videoTracks,targetTrack+1);ensureTrackHeightCounts();
    for(const file of list){
      const url=URL.createObjectURL(file),probe=document.createElement('video');probe.preload='metadata';probe.src=url;
      const meta=await new Promise(resolve=>{const done=value=>{probe.onloadedmetadata=null;probe.onerror=null;resolve(value);};probe.onloadedmetadata=()=>done({duration:probe.duration,width:probe.videoWidth,height:probe.videoHeight});probe.onerror=()=>done(null);setTimeout(()=>done(null),5000);});
      probe.removeAttribute('src');probe.load();
      if(!meta||!Number.isFinite(meta.duration)||meta.duration<=MIN_SHOT_SECONDS){URL.revokeObjectURL(url);notify(`Could not read ${file.name}`);continue;}
      const sourceDuration=clamp(meta.duration,MIN_SHOT_SECONDS,600),clipDuration=durationWithinSequence(cursor,sourceDuration,sourceDuration);if(!clipDuration){URL.revokeObjectURL(url);notify('The fixed sequence has no room for another video');break;}
      const clip={id:uid(),itemId:null,mediaKind:'video',mediaId:uid(),track:targetTrack,start:cursor,duration:clipDuration,sourceIn:0,sourceOut:clipDuration,originalDuration:meta.duration,name:file.name||`Video ${project.clips.length+1}`,type:file.type||'video/mp4',blob:file,url,needsRelink:false,videoWidth:meta.width||0,videoHeight:meta.height||0,enabled:true,framing:{fit:'contain',scale:1,x:0,y:0},strokes:[]};
      project.clips.push(clip);cursor+=clipDuration;setTimelineSelection([clip.id],clip.id);added++;
    }
    if(added){project.playhead=project.clips.find(c=>c.id===selectedClipId)?.start||project.playhead;markDirty();renderAll();notify(`Added ${added} video clip${added===1?'':'s'}`);}
    return added;
  }

  function sourcePixelSize(source){
    return {width:source?.videoWidth||source?.naturalWidth||source?.width||0,height:source?.videoHeight||source?.naturalHeight||source?.height||0};
  }

  function clipVisualGeometry(clip,source){
    const {width,height}=sourcePixelSize(source);
    return width&&height?visualSourceGeometry(width,height,isVideoClip(clip)?null:clip.boardTransform):null;
  }

  function drawClipVisual(targetCtx,clip,source,cx,cy,scale){
    const geometry=clipVisualGeometry(clip,source);if(!geometry)return null;
    const {transform,source:src,baseWidth,baseHeight,rotationRadians}=geometry;
    targetCtx.save();targetCtx.translate(cx,cy);targetCtx.rotate(rotationRadians);
    if(transform){targetCtx.scale(transform.flipX?-1:1,transform.flipY?-1:1);if(transform.gray)targetCtx.filter='grayscale(1)';}
    targetCtx.drawImage(source,src.x,src.y,src.width,src.height,-baseWidth*scale/2,-baseHeight*scale/2,baseWidth*scale,baseHeight*scale);
    targetCtx.restore();return geometry;
  }

  function drawFramedVisual(targetCtx,clip,source,w,h,overrideFraming=null){
    const geometry=clipVisualGeometry(clip,source);if(!geometry)return null;
    const framing=overrideFraming||clip.framing||{fit:'contain',scale:1,x:0,y:0};
    const baseK=framing.fit==='cover'?Math.max(w/geometry.rotatedWidth,h/geometry.rotatedHeight):Math.min(w/geometry.rotatedWidth,h/geometry.rotatedHeight);
    const scale=baseK*clamp(Number(framing.scale)||1,.01,8);
    const cx=w/2+clamp(Number(framing.x)||0,-1,1)*w/2,cy=h/2+clamp(Number(framing.y)||0,-1,1)*h/2;
    drawClipVisual(targetCtx,clip,source,cx,cy,scale);return geometry;
  }

  async function thumbUrl(clip) {
    const key=clip.mediaId||clip.sourceAssetKey||clip.itemId;
    if (thumbUrls.has(key)) return thumbUrls.get(key);
    const image = isVideoClip(clip)?null:getImage(clip.itemId);
    const source = isVideoClip(clip)?await videoSourceAt(clip,clip.start,true):(image?.proxy || await getBitmap(clip.itemId, { priority:'display' }));
    if (!source) return '';
    const c = document.createElement('canvas'); c.width=120; c.height=68;
    const g=c.getContext('2d'); g.fillStyle='#111'; g.fillRect(0,0,120,68);
    if(!drawFramedVisual(g,clip,source,120,68,{fit:'cover',scale:1,x:0,y:0}))return '';
    const url=c.toDataURL('image/jpeg',.7); c.width=c.height=0;
    thumbUrls.set(key,url); return url;
  }

  function fittedTimelineZoom(total=duration()){
    const available=scroll.clientWidth-TRACK_LABEL_WIDTH;
    if(!(available>0)||!(total>0))return null;
    return clamp(available/total,MIN_TIMELINE_ZOOM,MAX_TIMELINE_ZOOM);
  }

  function renderTimeline() {
    clearRazorGuide();
    ensureTrackHeightCounts();
    syncActiveTrackTargets();
    const fixed=fixedSequenceEnd(),total=duration(),zoom=$('#anZoom'),fitZoom=fittedTimelineZoom(total),previousFit=timelineFitZoom,wasFitted=Number.isFinite(fitZoom)&&Number.isFinite(previousFit)&&Math.abs((Number(project.timelineZoom)||0)-previousFit)<=Math.max(.002,previousFit*.002);
    zoom.min=String(fitZoom??MIN_TIMELINE_ZOOM);zoom.max=String(MAX_TIMELINE_ZOOM);
    if(Number.isFinite(fitZoom)){if(wasFitted)project.timelineZoom=fitZoom;timelineFitZoom=fitZoom;}
    const px=clamp(Number(project.timelineZoom)||90,Number(zoom.min)||MIN_TIMELINE_ZOOM,Number(zoom.max)||MAX_TIMELINE_ZOOM);project.timelineZoom=px;zoom.value=String(px);
    const laneWidth = Math.max(1,total*px),ticks=timelineRulerTicks(total,px);
    grid.style.setProperty('--an-second-px',`${px}px`);
    grid.style.setProperty('--an-lane-width',`${laneWidth}px`);
    grid.style.setProperty('--an-timeline-end-x',`${laneWidth}px`);
    grid.style.width=`${TRACK_LABEL_WIDTH+laneWidth}px`;
    let html='<div class="an-playhead"></div><div class="an-snap-guide"><span></span></div><div class="an-timeline-end"></div>';
    if(hasSequenceRange())html+=`<div class="an-sequence-range" style="--an-in-x:${project.inPoint*px}px;--an-range-w:${(project.outPoint-project.inPoint)*px}px"></div>`;
    if(Number.isFinite(project.inPoint))html+=`<div class="an-sequence-marker in" data-sequence-marker="in" role="separator" aria-label="Sequence In point" aria-orientation="vertical" tabindex="0" style="--an-marker-x:${project.inPoint*px}px" title="Drag sequence In"></div>`;
    if(Number.isFinite(project.outPoint))html+=`<div class="an-sequence-marker out" data-sequence-marker="out" role="separator" aria-label="Sequence Out point" aria-orientation="vertical" tabindex="0" style="--an-marker-x:${project.outPoint*px}px" title="Drag sequence Out"></div>`;
    const timeMode=project.timelineDisplay==='frames'?'FRAMES':'TIMECODE';
    html+=`<div class="an-ruler-row"><div class="an-track-label"><button class="an-time-mode" data-time-display title="Toggle timeline between timecode and frames">${timeMode}</button></div><div class="an-ruler">`;
    for(const s of ticks){const label=project.timelineDisplay==='frames'?`F ${Math.round(s*project.fps)}`:timecode(s,project.fps);html+=`<span class="an-tick" style="left:${s*px}px">${label}</span>`;}
    html+='</div></div>';
    if(project.texts.length){
      const textLocked=isTrackLocked('text'),textLock=`<button class="an-track-toggle lock ${textLocked?'on':''}" data-toggle-track-lock="text" data-track="0" title="${textLocked?'Unlock':'Lock'} text track T1" aria-label="${textLocked?'Unlock':'Lock'} text track T1" aria-pressed="${String(textLocked)}">${lockIcon(textLocked)}</button>`;
      html+=`<div class="an-track-row${textLocked?' track-locked':''}" data-track-kind="text" data-track-index="0"><div class="an-track-label"><b>T1</b><span>TEXT</span><div class="an-track-actions">${textLock}</div></div><div class="an-track-lane" data-kind="text" data-track="0" style="width:${laneWidth}px">`;
      for(const text of project.texts)html+=clipMarkup(text,px,'text');
      html+='</div></div>';
    }
    for(let track=0;track<project.videoTracks;track++){
      const height=trackHeight('video',track),rowClass=height<34?' compact':'';
      const grip=`<button class="an-track-grip" data-track-move="video" data-track="${track}" title="Drag to reorder V${track+1}" aria-label="Drag to reorder video track V${track+1}"><svg viewBox="0 0 12 16"><circle cx="3" cy="3" r="1.2"/><circle cx="9" cy="3" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="9" cy="8" r="1.2"/><circle cx="3" cy="13" r="1.2"/><circle cx="9" cy="13" r="1.2"/></svg></button>`;
      const trackLocked=isTrackLocked('video',track),target=`<button class="an-track-target ${track===activeVideoTrack?'on':''}" data-target-track="video" data-track="${track}" title="${trackLocked?`V${track+1} is locked`:`Paste to V${track+1}`}" aria-label="Target video track V${track+1}" aria-pressed="${String(track===activeVideoTrack)}" ${trackLocked?'disabled':''}>V${track+1}</button>`;
      const remove=project.videoTracks>1?`<button class="an-track-remove" data-remove-track="video" data-track="${track}" title="Remove empty V${track+1}" aria-label="Remove video track V${track+1}"><svg viewBox="0 0 12 12"><path d="m2 2 8 8M10 2 2 10"/></svg></button>`:'';
      const trackEnabled=isVideoTrackEnabled(track),visibility=`<button class="an-track-visibility ${trackEnabled?'':'off'}" data-toggle-track-visibility="${track}" title="${trackEnabled?'Disable':'Enable'} video track V${track+1}" aria-label="${trackEnabled?'Disable':'Enable'} video track V${track+1}" aria-pressed="${String(!trackEnabled)}">${visibilityIcon(trackEnabled)}</button>`;
      const lock=`<button class="an-track-toggle lock ${trackLocked?'on':''}" data-toggle-track-lock="video" data-track="${track}" title="${trackLocked?'Unlock':'Lock'} video track V${track+1}" aria-label="${trackLocked?'Unlock':'Lock'} video track V${track+1}" aria-pressed="${String(trackLocked)}">${lockIcon(trackLocked)}</button>`;
      html+=`<div class="an-track-row${rowClass}${trackEnabled?'':' track-disabled'}${trackLocked?' track-locked':''}" data-track-kind="video" data-track-index="${track}" style="--an-track-height:${height}px"><div class="an-track-label">${grip}${target}<span>VIDEO</span><div class="an-track-actions">${visibility}${lock}${remove}</div></div><div class="an-track-lane" data-kind="video" data-track="${track}" style="width:${laneWidth}px">`;
      for(const gap of timelineTrackGaps(project.clips,track,{minDuration:1/project.fps-1e-8}))html+=gapMarkup(gap,px,'video');
      for(const clip of project.clips.filter(c=>c.track===track)) html+=clipMarkup(clip,px,'video');
      html+=`</div><button class="an-track-resize" data-track-resize="video" data-track="${track}" role="separator" aria-orientation="horizontal" aria-label="Resize video track V${track+1}" title="Drag to resize V${track+1} · double-click to reset"></button></div>`;
    }
    if(project.videoTracks<MAX_VIDEO_TRACKS) html+=`<button class="an-track-add" data-add-track="video">+ Add video track <span>(${project.videoTracks}/${MAX_VIDEO_TRACKS})</span></button>`;
    for(let track=0;track<project.audioTracks;track++){
      const height=trackHeight('audio',track),rowClass=height<34?' compact':'';
      const grip=`<button class="an-track-grip" data-track-move="audio" data-track="${track}" title="Drag to reorder A${track+1}" aria-label="Drag to reorder audio track A${track+1}"><svg viewBox="0 0 12 16"><circle cx="3" cy="3" r="1.2"/><circle cx="9" cy="3" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="9" cy="8" r="1.2"/><circle cx="3" cy="13" r="1.2"/><circle cx="9" cy="13" r="1.2"/></svg></button>`;
      const trackLocked=isTrackLocked('audio',track),muted=project.audioTrackMuted?.[track]===true,solo=project.audioTrackSolo?.[track]===true,target=`<button class="an-track-target ${track===activeAudioTrack?'on':''}" data-target-track="audio" data-track="${track}" title="${trackLocked?`A${track+1} is locked`:`Paste to A${track+1}`}" aria-label="Target audio track A${track+1}" aria-pressed="${String(track===activeAudioTrack)}" ${trackLocked?'disabled':''}>A${track+1}</button>`;
      const remove=`<button class="an-track-remove" data-remove-track="audio" data-track="${track}" title="Remove empty A${track+1}" aria-label="Remove audio track A${track+1}"><svg viewBox="0 0 12 12"><path d="m2 2 8 8M10 2 2 10"/></svg></button>`;
      const mute=`<button class="an-track-toggle mute ${muted?'on':''}" data-toggle-audio-mute="${track}" title="${muted?'Unmute':'Mute'} audio track A${track+1}" aria-label="${muted?'Unmute':'Mute'} audio track A${track+1}" aria-pressed="${String(muted)}">M</button>`,soloButton=`<button class="an-track-toggle solo ${solo?'on':''}" data-toggle-audio-solo="${track}" title="${solo?'Disable solo':'Solo'} audio track A${track+1}" aria-label="${solo?'Disable solo':'Solo'} audio track A${track+1}" aria-pressed="${String(solo)}">S</button>`,lock=`<button class="an-track-toggle lock ${trackLocked?'on':''}" data-toggle-track-lock="audio" data-track="${track}" title="${trackLocked?'Unlock':'Lock'} audio track A${track+1}" aria-label="${trackLocked?'Unlock':'Lock'} audio track A${track+1}" aria-pressed="${String(trackLocked)}">${lockIcon(trackLocked)}</button>`;
      html+=`<div class="an-track-row${rowClass}${muted||hasSoloAudioTrack()&&!solo?' track-muted':''}${trackLocked?' track-locked':''}" data-track-kind="audio" data-track-index="${track}" style="--an-track-height:${height}px"><div class="an-track-label">${grip}${target}<span>AUDIO</span><div class="an-track-actions">${mute}${soloButton}${lock}${remove}</div></div><div class="an-track-lane" data-kind="audio" data-track="${track}" style="width:${laneWidth}px">`;
      for(const gap of timelineTrackGaps(project.audio,track,{minDuration:1/project.fps-1e-8}))html+=gapMarkup(gap,px,'audio');
      for(const clip of project.audio.filter(c=>c.track===track)) html+=clipMarkup(clip,px,'audio');
      html+=`</div><button class="an-track-resize" data-track-resize="audio" data-track="${track}" role="separator" aria-orientation="horizontal" aria-label="Resize audio track A${track+1}" title="Drag to resize A${track+1} · double-click to reset"></button></div>`;
    }
    if(project.audioTracks<MAX_AUDIO_TRACKS) html+=`<button class="an-track-add" data-add-track="audio">+ Add audio track <span>(${project.audioTracks}/${MAX_AUDIO_TRACKS})</span></button>`;
    grid.innerHTML=html;
    grid.style.setProperty('--an-playhead-x',`${project.playhead*px}px`);
    syncPlayheadVisibility();
    const range=hasSequenceRange()?` · IN ${timecode(project.inPoint,project.fps)} → OUT ${timecode(project.outPoint,project.fps)}`:'';
    $('#anTlSummary').textContent=`${project.clips.length} media · ${project.texts.length} text · ${formatDuration(duration())}${fixed===null?'':' fixed'}${range}`;
    $('#anSetIn').classList.toggle('on',Number.isFinite(project.inPoint));$('#anSetOut').classList.toggle('on',Number.isFinite(project.outPoint));
    $('#anSnap').classList.toggle('on',project.timelineSnap);$('#anSnap').setAttribute('aria-pressed',String(project.timelineSnap));
    syncLinkButton();
    hydrateThumbs();hydrateWaveforms();
  }

  function gapKey(kind,gap){return `${kind}:${gap.track}:${gap.start.toFixed(6)}:${gap.end.toFixed(6)}`;}

  function gapMarkup(gap,px,kind){
    const key=gapKey(kind,gap),selected=selectedGap?.key===key,width=Math.max(2,(gap.end-gap.start)*px);
    return `<button class="an-gap ${selected?'on':''}" data-gap="${esc(key)}" data-kind="${kind}" data-track="${gap.track}" data-start="${gap.start}" data-end="${gap.end}" style="left:${gap.start*px}px;width:${width}px" title="Gap ${timecode(gap.duration,project.fps)} · click, then press Delete" aria-label="Gap ${timecode(gap.duration,project.fps)} on ${kind==='video'?'video':'audio'} track ${gap.track+1}"><span>${timecode(gap.duration,project.fps)} · Delete</span></button>`;
  }

  function audioFadeMarkup(clip,px){
    const fades=normalizedAudioFades(clip),duration=Math.max(MIN_SHOT_SECONDS,clip.duration),points=audioEnvelopePoints({...clip,...fades},{samplesPerFade:20}).map(point=>`${(point.time/duration*100).toFixed(3)},${(2+(1-point.gain)*20).toFixed(3)}`).join(' '),inX=fades.fadeInDuration*px,outX=(duration-fades.fadeOutDuration)*px;
    return `<svg class="an-fade-envelope" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polyline points="${points}"></polyline></svg><button class="an-fade-handle in" data-audio-fade="in" aria-label="Drag fade in duration" title="Fade in · ${fades.fadeInDuration.toFixed(2)}s" style="left:${inX}px"></button><button class="an-fade-handle out" data-audio-fade="out" aria-label="Drag fade out duration" title="Fade out · ${fades.fadeOutDuration.toFixed(2)}s" style="left:${outX}px"></button>`;
  }

  function updateAudioFadeVisual(clipEl,clip,px){
    const fades=normalizedAudioFades(clip),duration=Math.max(MIN_SHOT_SECONDS,clip.duration),points=audioEnvelopePoints({...clip,...fades},{samplesPerFade:20}).map(point=>`${(point.time/duration*100).toFixed(3)},${(2+(1-point.gain)*20).toFixed(3)}`).join(' '),fadeIn=clipEl.querySelector('[data-audio-fade="in"]'),fadeOut=clipEl.querySelector('[data-audio-fade="out"]');
    clipEl.querySelector('.an-fade-envelope polyline')?.setAttribute('points',points);if(fadeIn){fadeIn.style.left=`${fades.fadeInDuration*px}px`;fadeIn.title=`Fade in · ${fades.fadeInDuration.toFixed(2)}s`;}if(fadeOut){fadeOut.style.left=`${(duration-fades.fadeOutDuration)*px}px`;fadeOut.title=`Fade out · ${fades.fadeOutDuration.toFixed(2)}s`;}
  }

  function paintAudioFadeDrag({snap=false}={}){
    const state=audioFadeDrag;if(!state)return;
    const maximum=Math.max(0,state.clip.duration-state.otherDuration),raw=clamp(Number(state.pendingDuration??state.startDuration)||0,0,maximum),duration=snap?clamp(Math.round(raw*project.fps)/project.fps,0,maximum):raw;
    state.pendingDuration=duration;state.clip[`fade${state.side}Duration`]=duration;const fades=applyNormalizedAudioFades(state.clip),actual=fades[`fade${state.side}Duration`],px=Number($('#anZoom').value)||90;
    updateAudioFadeVisual(state.clipEl,state.clip,px);const input=$(`#anFade${state.side}Duration`);if(input)input.value=String(Number(actual.toFixed(3)));updateActiveAudioGain(state.clip);
  }

  function scheduleAudioFadeDragPaint(){
    if(audioFadeDragRaf)return;audioFadeDragRaf=requestAnimationFrame(()=>{audioFadeDragRaf=0;paintAudioFadeDrag();});
  }

  function flushAudioFadeDrag(snap=false){
    if(audioFadeDragRaf){cancelAnimationFrame(audioFadeDragRaf);audioFadeDragRaf=0;}paintAudioFadeDrag({snap});
  }

  function clipMarkup(clip,px,kind){
    const left=clip.start*px,width=Math.max(16,clip.duration*px);
    const selected=selectedTimelineIds.has(clip.id),primary=clip.id===primarySelectionId();
    const linkedPeer=!!clip.linkGroupId&&timelineMediaItems().some(item=>item.linkGroupId===clip.linkGroupId&&selectedTimelineIds.has(item.id));
    const visual=kind==='audio'?`<canvas class="an-wave" data-wave="${esc(clip.id)}"></canvas>`:kind==='text'?'':`<img data-thumb="${esc(clip.id)}" alt="">`;
    const linkBadge=clip.linkGroupId?'<span class="an-link-badge" title="Linked"><svg viewBox="0 0 16 16"><path d="m6.4 9.6 3.2-3.2M5 11l-1 1a2.1 2.1 0 0 1-3-3l2-2a2.1 2.1 0 0 1 3 0M11 5l1-1a2.1 2.1 0 0 1 3 3l-2 2a2.1 2.1 0 0 1-3 0"/></svg></span>':'';
    const label=kind==='text'?clip.content:clip.name;
    const disabled=kind==='video'&&!isVisualClipEnabled(clip);
    return `<div class="an-clip ${kind==='audio'?'an-audio':kind==='text'?'an-text-clip':isVideoClip(clip)?'an-video':''} ${disabled?'clip-disabled':''} ${selected?'on':''} ${primary?'primary':''} ${linkedPeer?'linked-peer':''}" data-clip="${esc(clip.id)}" data-kind="${kind}" style="left:${left}px;width:${width}px"><i class="an-trim an-trim-left" data-trim="left"></i>${visual}${kind==='audio'?audioFadeMarkup(clip,px):''}${linkBadge}<span class="an-clip-name">${esc(label)}</span><span class="an-clip-dur">${clipDurationLabel(clip)}</span><i class="an-trim" data-trim="right"></i></div>`;
  }

  async function hydrateThumbs(){
    for(const img of grid.querySelectorAll('[data-thumb]')){
      const clip=project.clips.find(c=>c.id===img.dataset.thumb); if(!clip) continue;
      img.src=await thumbUrl(clip);
    }
  }

  async function decodeAudioBlob(blob){
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;if(!AudioContextClass||!blob)return null;
    const audioContext=new AudioContextClass();
    try{
      const buffer=await audioContext.decodeAudioData(await blob.arrayBuffer());
      const channels=Array.from({length:buffer.numberOfChannels},(_,index)=>buffer.getChannelData(index));
      return {duration:buffer.duration,peaks:waveformPeaks(channels,2048)};
    }finally{await audioContext.close().catch(()=>{});}
  }

  function ensureAudioWaveform(clip){
    if(!clip?.mediaId||!clip.blob)return Promise.resolve(null);
    if(audioWaveformCache.has(clip.mediaId))return Promise.resolve(audioWaveformCache.get(clip.mediaId));
    if(audioWaveformJobs.has(clip.mediaId))return audioWaveformJobs.get(clip.mediaId);
    const epoch=audioWaveformEpoch,job=decodeAudioBlob(clip.blob).then(result=>{if(result&&epoch===audioWaveformEpoch)audioWaveformCache.set(clip.mediaId,result);return epoch===audioWaveformEpoch?result:null;}).catch(err=>{console.warn('[animatics] timeline waveform unavailable',err);return null;}).finally(()=>audioWaveformJobs.delete(clip.mediaId));
    audioWaveformJobs.set(clip.mediaId,job);return job;
  }

  function drawTimelineWaveform(canvas,clip,waveform){
    if(!canvas.isConnected||!waveform?.peaks?.length)return;
    const cssWidth=Math.max(24,canvas.getBoundingClientRect().width),dpr=Math.min(2,devicePixelRatio||1);
    canvas.width=Math.min(1600,Math.max(48,Math.round(cssWidth*dpr)));canvas.height=56;
    const g=canvas.getContext('2d'),peaks=waveformWindow(waveform.peaks,clip.sourceIn||0,clip.sourceOut||clip.originalDuration,waveform.duration||clip.originalDuration);
    g.clearRect(0,0,canvas.width,canvas.height);g.fillStyle='#92e5bc';
    for(let x=0;x<canvas.width;x++){
      const from=Math.floor(x/canvas.width*peaks.length),to=Math.max(from+1,Math.ceil((x+1)/canvas.width*peaks.length));let peak=0;
      for(let i=from;i<to&&i<peaks.length;i++)peak=Math.max(peak,peaks[i]||0);
      const localTime=(x+.5)/canvas.width*Math.max(0,clip.duration),displayPeak=audioWaveformDisplayPeak(clip,peak,localTime),h=Math.max(1,displayPeak*(canvas.height-6));g.fillRect(x,(canvas.height-h)/2,1,h);
    }
  }

  function redrawTimelineWaveforms(clips){
    for(const clip of clips||[]){const canvas=grid.querySelector(`canvas[data-wave="${CSS.escape(clip.id)}"]`),waveform=audioWaveformCache.get(clip.mediaId);if(canvas&&waveform)drawTimelineWaveform(canvas,clip,waveform);}
  }

  async function hydrateWaveforms(){
    for(const canvas of grid.querySelectorAll('canvas[data-wave]')){
      const clip=project.audio.find(item=>item.id===canvas.dataset.wave);if(!clip)continue;
      const waveform=await ensureAudioWaveform(clip);if(waveform&&canvas.dataset.wave===clip.id)drawTimelineWaveform(canvas,clip,waveform);
    }
  }

  function formatDuration(sec){const total=Math.max(0,Math.round(sec)),s=total%60,m=Math.floor(total/60)%60,h=Math.floor(total/3600);return h?`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`;}

  function clipDurationLabel(clip){
    return project.counterMode==='frames' ? `${Math.max(1,Math.round(clip.duration*project.fps))} fr` : `${clip.duration.toFixed(1)}s`;
  }

  function counterLabel(seconds, withPrefix=true){
    if(project.counterMode==='frames'){
      const frame=Math.max(0,Math.floor(seconds*project.fps+1e-6));
      return `${withPrefix?'F ':''}${String(frame).padStart(6,'0')}`;
    }
    if(project.counterMode==='seconds')return `${seconds.toFixed(2)} s`;
    return timecode(seconds,project.fps);
  }

  function textsAt(t){
    return project.texts.filter(text=>t>=text.start&&t<text.start+text.duration);
  }

  function textLayout(targetCtx,text,w,h){
    const scale=clamp(Number(text.scale)||1,.25,4),align=normalizeTextAlign(text.align),design=sequenceDimensions(TEXT_DESIGN_SHORT_EDGE,project.aspect),projection=w/Math.max(1,design.width),designSize=clamp(Number(text.size)||42,8,300)*scale*(design.width/TEXT_COORDINATE_WIDTH),size=designSize*projection;
    const lines=String(text.content??'').split(/\r?\n/).slice(0,12),designLineH=designSize*1.2,lineH=designLineH*projection,pad=14*(design.width/TEXT_COORDINATE_WIDTH)*scale*projection;
    targetCtx.save();targetCtx.font=textCanvasFont(text,designSize);targetCtx.textAlign=align;targetCtx.textBaseline='alphabetic';
    const measured=lines.map(line=>targetCtx.measureText(line||' ')),probe=targetCtx.measureText('Mg'),maxAdvance=Math.max(designSize*.18,...measured.map(metric=>metric.width));
    const fallbackAscent=Math.max(1,probe.actualBoundingBoxAscent||probe.fontBoundingBoxAscent||designSize*.78),fallbackDescent=Math.max(0,probe.actualBoundingBoxDescent||probe.fontBoundingBoxDescent||designSize*.22),rawLineX=align==='left'?-maxAdvance/2:align==='right'?maxAdvance/2:0;
    let left=-maxAdvance/2,right=maxAdvance/2,top=Infinity,bottom=-Infinity;
    const rawBaselines=measured.map((metric,index)=>{
      const baseline=index*designLineH,ascent=metric.actualBoundingBoxAscent>0?metric.actualBoundingBoxAscent:fallbackAscent,descent=metric.actualBoundingBoxDescent>0?metric.actualBoundingBoxDescent:fallbackDescent;
      const fallbackLeft=align==='left'?0:align==='right'?metric.width:metric.width/2,fallbackRight=align==='left'?metric.width:align==='right'?0:metric.width/2,inkLeft=Number.isFinite(metric.actualBoundingBoxLeft)?metric.actualBoundingBoxLeft:fallbackLeft,inkRight=Number.isFinite(metric.actualBoundingBoxRight)?metric.actualBoundingBoxRight:fallbackRight;
      left=Math.min(left,rawLineX-inkLeft);right=Math.max(right,rawLineX+inkRight);top=Math.min(top,baseline-ascent);bottom=Math.max(bottom,baseline+descent);return baseline;
    });
    targetCtx.restore();
    if(!Number.isFinite(top)||!Number.isFinite(bottom)){top=-fallbackAscent;bottom=fallbackDescent;}
    const centerX=(left+right)/2,centerY=(top+bottom)/2,lineX=(rawLineX-centerX)*projection,lineYs=rawBaselines.map(baseline=>(baseline-centerY)*projection),halfW=Math.max(.5,(right-left)*projection/2),halfH=Math.max(.5,(bottom-top)*projection/2),maxWidth=maxAdvance*projection,boxH=(bottom-top)*projection,backgroundX=-centerX*projection;
    return {scale,size,lines,lineH,lineX,lineYs,maxWidth,boxH,backgroundX,pad,align,cx:clamp(finiteOr(text.x,.5),0,1)*w,cy:clamp(finiteOr(text.y,.82),0,1)*h,rotation:clamp(finiteOr(text.rotation,0),-180,180)*Math.PI/180,halfW,halfH};
  }

  function textUiMetrics(layout,w){
    const rect=canvas.getBoundingClientRect(),uiScale=w/Math.max(1,rect.width);
    return {handle:8*uiScale,hit:12*uiScale,rotateOffset:30*uiScale,anchor:6*uiScale,selectionPad:2*uiScale};
  }

  function textControlBounds(layout,w){const {selectionPad}=textUiMetrics(layout,w);return {halfW:layout.halfW+selectionPad,halfH:layout.halfH+selectionPad};}

  function drawTextOverlay(targetCtx,text,w,h,selected=false){
    const layout=textLayout(targetCtx,text,w,h),{size,lines,lineX,lineYs,maxWidth,boxH,backgroundX,pad,align,cx,cy,rotation}=layout;
    targetCtx.save();targetCtx.translate(cx,cy);targetCtx.rotate(rotation);
    targetCtx.font=textCanvasFont(text,size);targetCtx.textAlign=align;targetCtx.textBaseline='alphabetic';
    if(text.background===true){
      targetCtx.fillStyle='rgba(0,0,0,.58)';targetCtx.fillRect(backgroundX-maxWidth/2-pad,-boxH/2-pad*.65,maxWidth+pad*2,boxH+pad*1.3);
    }
    targetCtx.fillStyle=text.color||'#fff';lines.forEach((line,index)=>targetCtx.fillText(line,lineX,lineYs[index]));
    if(selected){
      const {handle,rotateOffset,anchor}=textUiMetrics(layout,w),{halfW,halfH}=textControlBounds(layout,w);
      targetCtx.strokeStyle='#69aaff';targetCtx.lineWidth=Math.max(1,2*(w/TEXT_COORDINATE_WIDTH));targetCtx.setLineDash([]);targetCtx.strokeRect(-halfW,-halfH,halfW*2,halfH*2);
      targetCtx.beginPath();targetCtx.moveTo(0,-halfH);targetCtx.lineTo(0,-halfH-rotateOffset);targetCtx.stroke();
      targetCtx.fillStyle='#0f1723';targetCtx.strokeStyle='#8bc1ff';
      for(const [x,y] of [[-halfW,-halfH],[0,-halfH],[halfW,-halfH],[-halfW,0],[halfW,0],[-halfW,halfH],[0,halfH],[halfW,halfH]]){targetCtx.beginPath();targetCtx.rect(x-handle/2,y-handle/2,handle,handle);targetCtx.fill();targetCtx.stroke();}
      targetCtx.beginPath();targetCtx.arc(0,-halfH-rotateOffset,handle*.65,0,Math.PI*2);targetCtx.fill();targetCtx.stroke();
      targetCtx.beginPath();targetCtx.arc(0,0,anchor,0,Math.PI*2);targetCtx.fill();targetCtx.stroke();targetCtx.beginPath();targetCtx.moveTo(-anchor*1.7,0);targetCtx.lineTo(anchor*1.7,0);targetCtx.moveTo(0,-anchor*1.7);targetCtx.lineTo(0,anchor*1.7);targetCtx.stroke();
    }
    targetCtx.restore();
  }

  function viewerPoint(event){const rect=canvas.getBoundingClientRect();return {x:(event.clientX-rect.left)*canvas.width/Math.max(1,rect.width),y:(event.clientY-rect.top)*canvas.height/Math.max(1,rect.height)};}

  function textLocalPoint(layout,point){const dx=point.x-layout.cx,dy=point.y-layout.cy,c=Math.cos(layout.rotation),s=Math.sin(layout.rotation);return {x:dx*c+dy*s,y:-dx*s+dy*c};}

  function hitTextControl(event){
    const point=viewerPoint(event),active=textsAt(project.playhead),ordered=[];
    const selected=active.find(text=>text.id===selectedTextId);if(selected)ordered.push(selected);for(const text of [...active].reverse())if(text.id!==selectedTextId)ordered.push(text);
    for(const text of ordered){
      const layout=textLayout(ctx,text,canvas.width,canvas.height),local=textLocalPoint(layout,point),{hit,rotateOffset}=textUiMetrics(layout,canvas.width),{halfW,halfH}=textControlBounds(layout,canvas.width);
      if(text.id===selectedTextId){
        if(Math.hypot(local.x,local.y+halfH+rotateOffset)<=hit)return {text,layout,point,mode:'rotate'};
        for(const handlePoint of [[-halfW,-halfH],[0,-halfH],[halfW,-halfH],[-halfW,0],[halfW,0],[-halfW,halfH],[0,halfH],[halfW,halfH]])if(Math.hypot(local.x-handlePoint[0],local.y-handlePoint[1])<=hit)return {text,layout,point,mode:'scale'};
      }
      if(Math.abs(local.x)<=halfW&&Math.abs(local.y)<=halfH)return {text,layout,point,mode:'move'};
    }
    return null;
  }

  function positionInlineTextEditor(){
    const text=project.texts.find(item=>item.id===inlineTextId);if(!text||!inlineTextEditor.classList.contains('open'))return;
    const layout=textLayout(ctx,text,canvas.width,canvas.height),rect=canvas.getBoundingClientRect(),displayW=rect.width/Math.max(.001,previewZoom),displayH=rect.height/Math.max(.001,previewZoom),width=clamp(layout.halfW*2*displayW/canvas.width+6,24,Math.max(24,displayW*.95)),height=clamp(Math.max(layout.boxH,layout.lineH*Math.max(1,layout.lines.length))*displayH/canvas.height+4,24,Math.max(24,displayH*.9));
    inlineTextEditor.style.left=`${text.x*100}%`;inlineTextEditor.style.top=`${text.y*100}%`;inlineTextEditor.style.width=`${width}px`;inlineTextEditor.style.height=`${height}px`;inlineTextEditor.style.fontSize=`${Math.max(1,layout.size*displayH/canvas.height)}px`;inlineTextEditor.style.lineHeight='1.2';inlineTextEditor.style.fontFamily=normalizeTextFontFamily(text.fontFamily);inlineTextEditor.style.fontWeight=text.bold===true?'700':'400';inlineTextEditor.style.fontStyle=text.italic===true?'italic':'normal';inlineTextEditor.style.textAlign=normalizeTextAlign(text.align);inlineTextEditor.style.color=text.color||'#fff';inlineTextEditor.style.transform=`translate(-50%,-50%) rotate(${clamp(finiteOr(text.rotation,0),-180,180)}deg)`;
  }

  function beginInlineTextEdit(text){
    if(isTrackLocked('text')){notify('T1 is locked');return;}
    inlineTextId=text.id;inlineTextOriginal=text.content;inlineTextEditor.value=text.content;drawViewerLive();inlineTextEditor.classList.add('open');positionInlineTextEditor();inlineTextEditor.focus();inlineTextEditor.select();
  }

  function finishInlineTextEdit(cancel=false){
    if(!inlineTextId)return;const text=project.texts.find(item=>item.id===inlineTextId),previous=inlineTextOriginal;
    if(text)text.content=cancel?previous:inlineTextEditor.value;inlineTextId=null;inlineTextOriginal='';inlineTextEditor.classList.remove('open');inlineTextEditor.removeAttribute('style');
    if(text){syncInspector();drawViewer();if(text.content!==previous&&!cancel){markDirty();renderTimeline();}}
  }

  function paintViewer(targetCtx,w,h,t,burnTc,mainViewer,active,activeTexts,layers){
    if(mainViewer&&!playing){const activeVideoIds=new Set(active.filter(isVideoClip).map(c=>c.id));for(const [id,video] of videoElements)if(!activeVideoIds.has(id))video.pause();}
    targetCtx.save(); targetCtx.fillStyle=project.background; targetCtx.fillRect(0,0,w,h);
    for(const {clip,source} of layers){
      if(!drawFramedVisual(targetCtx,clip,source,w,h))continue;
      if(mainViewer&&clip.id===activeDrawingClipId&&activeDrawingOverlay){targetCtx.drawImage(activeDrawingOverlay,0,0,w,h);if(activeStroke?.tool!=='eraser'&&activeDrawingStrokeCanvas){const brush=DRAW_BRUSHES[activeStroke.brush]||DRAW_BRUSHES.pen;targetCtx.save();targetCtx.globalAlpha=brush.alpha;targetCtx.drawImage(activeDrawingStrokeCanvas,0,0,w,h);targetCtx.restore();}}
      else drawClipDrawings(targetCtx,clip,w,h);
    }
    for(const text of activeTexts){if(mainViewer&&text.id===inlineTextId)continue;drawTextOverlay(targetCtx,text,w,h,mainViewer&&text.id===selectedTextId);}
    if(burnTc){
      const fs=Math.max(14,22*(w/1280)); targetCtx.font=`600 ${fs}px ui-monospace,Consolas,monospace`; targetCtx.textAlign='left'; targetCtx.textBaseline='top';
      const label=counterLabel(t),pad=10*(w/1280); const tw=targetCtx.measureText(label).width;
      targetCtx.fillStyle='rgba(0,0,0,.62)'; targetCtx.fillRect(pad,pad,tw+pad*1.4,fs+pad);
      targetCtx.fillStyle='#fff'; targetCtx.fillText(label,pad*1.7,pad*1.45);
    }
    targetCtx.restore();
    if(!mainViewer)return;
    $('#anEmpty')?.classList.toggle('hide',active.length>0||activeTexts.length>0);
    const nextPreviewShotKey=active.at(-1)?.id||activeTexts.at(-1)?.id||'';
    if(previewShotKey&&previewShotKey!==nextPreviewShotKey&&!previewZoomLocked&&previewZoom!==1)fitPreviewZoom({show:false});
    previewShotKey=nextPreviewShotKey;
    const top=active.at(-1);$('#anShotLabel').innerHTML=top?`<b class="an-shot-name" title="${esc(top.name)}">${esc(top.name)}</b><span class="an-shot-meta">&nbsp;· ${Math.max(1,Math.round(top.duration*project.fps))} frames · V${top.track+1}</span>`:activeTexts.length?'<b class="an-shot-name">Text overlay</b><span class="an-shot-meta">&nbsp;· T1</span>':'No shot at playhead';
  }

  async function drawViewer(targetCtx=ctx, w=canvas.width, h=canvas.height, t=project.playhead, burnTc=project.timecode, fullQuality=false){
    const mainViewer=targetCtx===ctx,drawToken=mainViewer?++viewerDrawToken:0,active=clipsAt(t),activeTexts=textsAt(t),layers=[];
    for(const clip of active){
      const image=isVideoClip(clip)?null:getImage(clip.itemId),needsFull=fullQuality||project.previewQuality==='full';
      const source=isVideoClip(clip)?await videoSourceAt(clip,t,fullQuality):(needsFull?await getBitmap(clip.itemId,{priority:'high'}):(image?.proxy||image?.bitmap||await getBitmap(clip.itemId,{priority:'high'})));
      if(mainViewer&&drawToken!==viewerDrawToken)return;
      if(source)layers.push({clip,source});
    }
    paintViewer(targetCtx,w,h,t,burnTc,mainViewer,active,activeTexts,layers);
  }

  function drawViewerLive(){
    const t=project.playhead,w=canvas.width,h=canvas.height,active=clipsAt(t),activeTexts=textsAt(t),layers=[];
    for(const clip of active){
      const image=isVideoClip(clip)?null:getImage(clip.itemId),video=isVideoClip(clip)?videoElements.get(clip.id):null;
      const source=isVideoClip(clip)?(video?.readyState>=2?video:null):(project.previewQuality==='full'?(image?.bitmap||image?.proxy):(image?.proxy||image?.bitmap));
      if(!source){drawViewer();return;}
      layers.push({clip,source});
    }
    viewerDrawToken++;paintViewer(ctx,w,h,t,project.timecode,true,active,activeTexts,layers);
  }

  function scheduleFramingPreview(){
    if(framingPreviewRaf)return;
    framingPreviewRaf=requestAnimationFrame(()=>{framingPreviewRaf=0;drawViewerLive();});
  }

  function flushFramingPreview({full=false}={}){
    if(framingPreviewRaf){cancelAnimationFrame(framingPreviewRaf);framingPreviewRaf=0;}
    if(full)void drawViewer();else drawViewerLive();
  }

  function scheduleFramingPreviewFinish(){
    clearTimeout(framingPreviewFinishTimer);
    framingPreviewFinishTimer=setTimeout(()=>{framingPreviewFinishTimer=0;flushFramingPreview({full:true});flushDeferredHistory();},140);
  }

  function cancelFramingPreview(){
    if(framingPreviewRaf)cancelAnimationFrame(framingPreviewRaf);
    framingPreviewRaf=0;clearTimeout(framingPreviewFinishTimer);framingPreviewFinishTimer=0;
  }

  function clipIntrinsicSize(clip){
    if(isVideoClip(clip))return {width:Math.max(1,clip.videoWidth||1),height:Math.max(1,clip.videoHeight||1)};
    const image=getImage(clip.itemId),geometry=visualSourceGeometry(image?.w||1,image?.h||1,clip.boardTransform);
    return {width:geometry.rotatedWidth,height:geometry.rotatedHeight};
  }

  function clipEffectiveFramingScale(clip){
    const size=clipIntrinsicSize(clip);return effectiveFramingScale(clip.framing,canvas.width||16,canvas.height||9,size.width,size.height);
  }

  function setClipEffectiveFramingScale(clip,effective){
    clip.framing=clip.framing||{fit:'contain',scale:1,x:0,y:0};const size=clipIntrinsicSize(clip);
    clip.framing.scale=clamp(framingScaleFromEffective(effective,clip.framing,canvas.width||16,canvas.height||9,size.width,size.height),.01,8);
  }

  function syncInspector(){
    const clip=selectedClip();
    const text=selectedText();
    const visuals=selectedVisualClips(),audios=selectedAudioClips(),durationItems=selectedDurationItems(),frameDuration=uniformValue(durationItems,item=>Math.max(1,Math.round(item.duration*project.fps)),0);
    for(const selector of ['#anDuration','#anAudioDuration']){const input=$(selector);input.value=frameDuration===null?'':String(Number((frameDuration/project.fps).toFixed(3)));input.disabled=!durationItems.length;}
    for(const selector of ['#anDurationFrames','#anAudioDurationFrames']){const input=$(selector);input.value=frameDuration===null?'':String(frameDuration??'');input.disabled=!durationItems.length;}
    $('#anClipSelectionTitle').textContent=visuals.length?`${visuals.length} visual clip${visuals.length===1?'':'s'} selected${audios.length?` · ${audios.length} audio`:''}`:'No visual clips selected';
    $('#anAudioSelectionTitle').textContent=audios.length?`${audios.length} audio clip${audios.length===1?'':'s'} selected${visuals.length?` · ${visuals.length} visual`:''}`:'No audio clips selected';
    const framing=visuals[0]?.framing||{fit:'contain',scale:1,x:0,y:0},scalePercent=uniformValue(visuals,item=>Math.round(clipEffectiveFramingScale(item)*100),0),allContain=visuals.length&&visuals.every(item=>(item.framing?.fit||'contain')==='contain'),allCover=visuals.length&&visuals.every(item=>item.framing?.fit==='cover');
    $('#anFrameFit').classList.toggle('on',!!allContain);$('#anFrameFill').classList.toggle('on',!!allCover);
    for(const selector of ['#anFrameFit','#anFrameFill','#anFrameReset'])$(selector).disabled=!visuals.length;
    $('#anFrameScale').value=String(scalePercent??Math.round((visuals[0]?clipEffectiveFramingScale(visuals[0]):framing.scale)*100));
    $('#anFrameScale').disabled=!visuals.length;
    $('#anFrameScaleVal').value=scalePercent===null?'Mixed':`${scalePercent}%`;
    $('#anFrameScaleVal').textContent=scalePercent===null?'Mixed':`${scalePercent}%`;
    const allDisabled=visuals.length&&visuals.every(clip=>!isVisualClipEnabled(clip)),visibilityButton=$('#anToggleClipVisibility');visibilityButton.disabled=!visuals.length;visibilityButton.classList.toggle('on',!!allDisabled);visibilityButton.textContent=allDisabled?'Enable selected':'Disable selected';visibilityButton.setAttribute('aria-pressed',String(!!allDisabled));
    $('#anSplit').disabled=!primarySelectionId();$('#anDeleteClip').disabled=!selectedTimelineIds.size;
    if(text){
      $('#anText').value=text.content;$('#anTextSize').value=String(text.size);applyTextColor(text.color);
      $('#anTextScale').value=String(Math.round(text.scale*100));$('#anTextScaleVal').value=`${Math.round(text.scale*100)}%`;$('#anTextScaleVal').textContent=`${Math.round(text.scale*100)}%`;
      $('#anTextRotation').value=String(Math.round(text.rotation));$('#anTextDuration').value=String(Number(text.duration.toFixed(3)));
      $('#anTextFont').value=normalizeTextFontFamily(text.fontFamily);
      for(const [selector,on] of [['#anTextBold',text.bold===true],['#anTextItalic',text.italic===true],['#anTextBackground',text.background===true]]){$(selector).classList.toggle('on',on);$(selector).setAttribute('aria-pressed',String(on));}
      const align=normalizeTextAlign(text.align);root.querySelectorAll('[data-an-text-align]').forEach(button=>{const on=button.dataset.anTextAlign===align;button.classList.toggle('on',on);button.setAttribute('aria-pressed',String(on));});
    }
    $('#anAddText').textContent=text?'Update text layer':'Add text layer';$('#anClearText').disabled=!text;
    const audioPercent=uniformValue(audios,item=>Math.round((item.volume??1)*100),0),audioFallback=Math.round((audios[0]?.volume??1)*100),allMuted=audios.length&&audios.every(item=>item.volume===0);$('#anAudioVolume').value=String(audioPercent??audioFallback);$('#anAudioVolume').disabled=!audios.length;$('#anAudioVolumeVal').value=audioPercent===null?'Mixed':`${audioPercent}%`;$('#anAudioVolumeVal').textContent=audioPercent===null?'Mixed':`${audioPercent}%`;
    $('#anAudioMute').disabled=!audios.length;$('#anAudioMute').classList.toggle('on',!!allMuted);$('#anAudioMute').textContent=allMuted?'Unmute selected':'Mute selected';$('#anAudioSplit').disabled=!primarySelectionId();$('#anAudioDelete').disabled=!selectedTimelineIds.size;
    $('#anAudioGain').disabled=!audios.length&&!project.audio.some(item=>item.track===activeAudioTrack&&!isTrackLocked('audio',activeAudioTrack));
    for(const side of ['In','Out']){const durationValue=uniformValue(audios,item=>normalizedAudioFades(item)[`fade${side}Duration`]),curveValue=uniformExactValue(audios,item=>normalizedAudioFades(item)[`fade${side}Curve`]),shapeValue=uniformValue(audios,item=>normalizedAudioFades(item)[`fade${side}Shape`],0),durationInput=$(`#anFade${side}Duration`),curveInput=$(`#anFade${side}Curve`),shapeInput=$(`#anFade${side}Shape`),custom=$(`#anFade${side}Custom`);durationInput.value=durationValue===null?'':String(Number((durationValue??0).toFixed(3)));durationInput.disabled=!audios.length;curveInput.value=curveValue||normalizedAudioFades(audios[0]||{})[`fade${side}Curve`];curveInput.disabled=!audios.length;shapeInput.value=String(shapeValue??0);shapeInput.disabled=!audios.length;custom.classList.toggle('show',curveInput.value==='custom');}
    syncDrawUi();
    $('#anTcToggle').classList.toggle('on',project.timecode);
    const counterName=project.counterMode==='frames'?'frame counter':project.counterMode==='seconds'?'seconds counter':'timecode';
    $('#anTcToggle').textContent=project.timecode?`Hide ${counterName} in picture`:`Show ${counterName} in picture`;
    $('#anCounterMode').value=project.counterMode;
    $('#anProjectFps').value=String(project.fps);
    $('#anFooterAspect').value=project.aspect;
    $('#anFooterQuality').value=project.previewQuality;
    syncAnimaticsSelectControls();
    $('#anFramingTitle').textContent=`${project.aspect} framing`;
    $('#anBackground').value=project.background;
    syncLinkButton();
    canvas.parentElement.classList.toggle('framing',framingMode&&!!clip);
    if(!drawMode&&!framingMode)canvas.style.cursor=text&&textsAt(project.playhead).some(t=>t.id===text.id)?'move':'default';
  }

  function renderTransport(){
    const play=$('#anPlay');
    const playState=playing?'1':'0';
    if(play.dataset.playing!==playState){
      play.dataset.playing=playState;
      play.innerHTML=playing?icon('<path d="M7 5h4v14H7zM14 5h4v14h-4z"/>',true):icon('<path d="m8 5 11 7-11 7z"/>',true);
    }
    $('#anTime').textContent=`${counterLabel(project.playhead)} / ${counterLabel(duration(),false)}`;
    const px=Number($('#anZoom').value)||90; grid.style.setProperty('--an-playhead-x',`${project.playhead*px}px`);syncPlayheadVisibility();
  }

  function syncPlayheadVisibility(){
    const px=Number($('#anZoom').value)||90,isOutside=time=>{const x=TRACK_LABEL_WIDTH+time*px-scroll.scrollLeft;return x<TRACK_LABEL_WIDTH||x>scroll.clientWidth;};
    grid.querySelector('.an-playhead')?.classList.toggle('out-of-view',isOutside(project.playhead));
    for(const marker of grid.querySelectorAll('[data-sequence-marker]')){const time=marker.dataset.sequenceMarker==='in'?project.inPoint:project.outPoint;marker.classList.toggle('out-of-view',!Number.isFinite(time)||isOutside(time));}
  }

  function followPlayhead(margin=56){
    if(!scroll.clientWidth)return;
    const px=Number($('#anZoom').value)||90,screenX=TRACK_LABEL_WIDTH+project.playhead*px-scroll.scrollLeft,left=TRACK_LABEL_WIDTH+margin,right=Math.max(left,scroll.clientWidth-margin);let next=scroll.scrollLeft;
    if(screenX<left)next=project.playhead*px-margin;
    else if(screenX>right)next=TRACK_LABEL_WIDTH+project.playhead*px-right;
    const maximum=Math.max(0,scroll.scrollWidth-scroll.clientWidth);next=clamp(next,0,maximum);
    if(Math.abs(next-scroll.scrollLeft)>.5)scroll.scrollLeft=next;
    syncPlayheadVisibility();
  }

  function applyTimelineZoom(nextZoom){
    const slider=$('#anZoom'),oldPx=Number(project.timelineZoom)||Number(slider.value)||90,next=clamp(Number(nextZoom)||oldPx,Number(slider.min)||MIN_TIMELINE_ZOOM,Number(slider.max)||MAX_TIMELINE_ZOOM),rect=scroll.getBoundingClientRect(),playheadX=TRACK_LABEL_WIDTH+project.playhead*oldPx-scroll.scrollLeft,anchorX=playheadX>=TRACK_LABEL_WIDTH&&playheadX<=rect.width?playheadX:Math.max(TRACK_LABEL_WIDTH,rect.width/2);
    project.timelineZoom=next;slider.value=String(next);renderTimeline();scroll.scrollLeft=Math.max(0,project.playhead*project.timelineZoom+TRACK_LABEL_WIDTH-anchorX);syncPlayheadVisibility();
  }

  function applyPreviewQuality(){
    const shortEdge=project.previewQuality==='full'?1080:project.previewQuality==='half'?540:270;
    const {width,height}=sequenceDimensions(shortEdge,project.aspect);
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    const [rw,rh]=ASPECT_RATIOS[project.aspect]||ASPECT_RATIOS['16:9'];
    canvas.parentElement.style.aspectRatio=`${rw}/${rh}`;
    $('#anFooterAspect').value=project.aspect;
    $('#anFooterQuality').value=project.previewQuality;
    syncAnimaticsSelectControls();
  }

  function clampPreviewPan(){
    const shell=canvas.parentElement,extraX=Math.max(0,shell.offsetWidth*(previewZoom-1)/2),extraY=Math.max(0,shell.offsetHeight*(previewZoom-1)/2);
    previewPanX=clamp(previewPanX,-extraX,extraX);previewPanY=clamp(previewPanY,-extraY,extraY);
    if(Math.abs(previewZoom-1)<.001){previewZoom=1;previewPanX=0;previewPanY=0;}
  }

  function hidePreviewZoomHud(){
    if(previewZoomLocked)return;
    $('#anPreviewZoomHud')?.classList.remove('show');
  }

  function revealPreviewZoomHud(){
    clearTimeout(previewZoomHudTimer);previewZoomHudTimer=0;
    $('#anPreviewZoomHud')?.classList.add('show');
    if(!previewZoomLocked)previewZoomHudTimer=setTimeout(hidePreviewZoomHud,1700);
  }

  function syncPreviewZoomUi({show=false}={}){
    const shell=canvas.parentElement,locked=$('#anPreviewLock'),fit=$('#anPreviewFit');
    clampPreviewPan();
    shell.style.setProperty('--an-preview-zoom',String(previewZoom));
    shell.style.setProperty('--an-preview-pan-x',`${previewPanX}px`);
    shell.style.setProperty('--an-preview-pan-y',`${previewPanY}px`);
    shell.classList.toggle('preview-zoomed',Math.abs(previewZoom-1)>.001);
    $('#anPreviewZoomValue').textContent=`${Math.round(previewZoom*100)}%`;
    fit.disabled=previewZoom===1&&previewPanX===0&&previewPanY===0;
    locked.classList.toggle('on',previewZoomLocked);locked.setAttribute('aria-pressed',String(previewZoomLocked));locked.textContent=previewZoomLocked?'Locked':'Lock';
    if(previewZoomLocked)$('#anPreviewZoomHud').classList.add('show');else if(show)revealPreviewZoomHud();
    positionInlineTextEditor();
  }

  function setPreviewZoom(next,{clientX=null,clientY=null,show=true}={}){
    const old=previewZoom,value=clamp(Number(next)||1,PREVIEW_ZOOM_MIN,PREVIEW_ZOOM_MAX),rect=canvas.parentElement.getBoundingClientRect();
    if(Number.isFinite(clientX)&&Number.isFinite(clientY)&&old>0){const ratio=value/old,offsetX=clientX-(rect.left+rect.width/2),offsetY=clientY-(rect.top+rect.height/2);previewPanX+=offsetX*(1-ratio);previewPanY+=offsetY*(1-ratio);}
    previewZoom=value;syncPreviewZoomUi({show});
  }

  function fitPreviewZoom({show=true}={}){
    previewZoom=1;previewPanX=0;previewPanY=0;syncPreviewZoomUi({show});
  }

  function setPreviewZoomLocked(locked){
    previewZoomLocked=!!locked;if(previewZoomLocked)finishPreviewPan();clearTimeout(previewZoomHudTimer);previewZoomHudTimer=0;syncPreviewZoomUi({show:true});
  }

  function finishPreviewPan(){
    if(!previewPanDrag)return;
    previewPanDrag=null;canvas.parentElement.classList.remove('preview-panning');
    canvas.style.cursor=spaceHand&&previewZoom>1&&!previewZoomLocked?'grab':'';
  }

  function applyTimelineHeight(){root.style.setProperty('--an-timeline-h',`${clamp(project.timelineHeight,180,Math.max(180,window.innerHeight-220))}px`);}
  function inspectorWidthMaximum(){return Math.max(MIN_INSPECTOR_WIDTH,Math.min(MAX_INSPECTOR_WIDTH,window.innerWidth-MIN_VIEWER_WIDTH));}
  function applyInspectorWidth(){
    project.inspectorWidth=clamp(Number(project.inspectorWidth)||DEFAULT_INSPECTOR_WIDTH,MIN_INSPECTOR_WIDTH,inspectorWidthMaximum());root.style.setProperty('--an-inspector-w',`${project.inspectorWidth}px`);const handle=$('#anInspectorResizer');if(handle){handle.setAttribute('aria-valuemax',String(inspectorWidthMaximum()));handle.setAttribute('aria-valuenow',String(Math.round(project.inspectorWidth)));}
  }

  function renderAll(){ applyTimelineHeight();applyInspectorWidth();applyPreviewQuality(); renderTimeline(); syncInspector(); renderTransport(); drawViewer(); }

  function setSafeGuidesVisible(visible){
    safeGuidesVisible=!!visible;const guides=$('#anSafeGuides'),button=$('#anGuides');guides.classList.toggle('show',safeGuidesVisible);guides.setAttribute('aria-hidden',String(!safeGuidesVisible));button.classList.toggle('on',safeGuidesVisible);button.setAttribute('aria-pressed',String(safeGuidesVisible));
  }

  function setPreviewMuted(muted){
    previewMuted=!!muted;const button=$('#anPreviewMute');button.classList.toggle('on',previewMuted);button.setAttribute('aria-pressed',String(previewMuted));button.title=previewMuted?'Unmute timeline preview':'Mute timeline preview';button.setAttribute('aria-label',button.title);button.innerHTML=previewVolumeIcon(previewMuted);for(const clip of project.audio)updateActiveAudioGain(clip);
  }

  function setPlayhead(value){ project.playhead=clamp(value,0,duration()); renderTransport();followPlayhead();drawViewer(); }

  function scheduleScrubPreview(){
    scrubPreviewQueued=true;if(scrubPreviewRaf||scrubPreviewBusy)return;
    scrubPreviewRaf=requestAnimationFrame(async()=>{scrubPreviewRaf=0;if(!open){scrubPreviewQueued=false;return;}scrubPreviewQueued=false;scrubPreviewBusy=true;try{await drawViewer();}finally{scrubPreviewBusy=false;if(scrubPreviewQueued)scheduleScrubPreview();}});
  }

  function scrubTo(value){project.playhead=clamp(value,0,duration());renderTransport();followPlayhead();scheduleScrubPreview();}

  function stopAudioPlayback(){
    for(const timer of audioTimers)clearTimeout(timer); audioTimers=[];
    for(const entry of audioPlayers){entry.player.pause();entry.player.src='';entry.source?.disconnect?.();entry.gain?.disconnect?.();} audioPlayers=[];
  }

  function releaseAudioPlaybackContext(){
    stopAudioPlayback();const context=playbackAudioContext;playbackAudioContext=null;if(context)void context.close().catch(()=>{});
  }

  function ensurePlaybackAudioContext(){
    if(playbackAudioContext&&playbackAudioContext.state!=='closed')return playbackAudioContext;
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    playbackAudioContext=AudioContextClass?new AudioContextClass():null;return playbackAudioContext;
  }

  function scheduleClipGain(parameter,clip,localTime=0,contextTime=0){
    if(!parameter)return;const start=clamp(Number(localTime)||0,0,clip.duration),base=previewAudioVolume(clip),points=audioEnvelopePoints(clip,{start,end:clip.duration,samplesPerFade:32});parameter.cancelScheduledValues?.(contextTime);const first=points[0]||{time:start,gain:audioFadeGainAt(clip,start)};parameter.setValueAtTime?.(base*first.gain,contextTime);for(const point of points.slice(1))parameter.linearRampToValueAtTime?.(base*point.gain,contextTime+Math.max(0,point.time-start));if(!parameter.setValueAtTime)parameter.value=base*first.gain;
  }

  function updateActiveAudioGain(clip){
    const value=previewAudioVolume(clip);
    for(const entry of audioPlayers)if(entry.clipId===clip?.id){const local=Math.max(0,(entry.player.currentTime||0)-(Number(clip.sourceIn)||0));if(entry.gain)scheduleClipGain(entry.gain.gain,clip,local,entry.context?.currentTime||0);else entry.player.volume=Math.min(1,value*audioFadeGainAt(clip,local));}
    redrawTimelineWaveforms(clip?[clip]:[]);
  }

  function startAudioPlayback(){
    stopAudioPlayback();
    for(const clip of project.audio){
      if(!clip.url||!isAudioTrackAudible(Number(clip.track)||0)||project.playhead>=clip.start+clip.duration)continue;
      const launch=()=>{
        if(!playing)return;
        const player=new Audio(clip.url),volume=previewAudioVolume(clip),context=ensurePlaybackAudioContext();let source=null,gain=null;
        if(context){void context.resume().catch(()=>{});source=context.createMediaElementSource(player);gain=context.createGain();gain.gain.value=volume;source.connect(gain).connect(context.destination);}else player.volume=Math.min(1,volume);
        const offset=Math.max(0,project.playhead-clip.start),sourceIn=Number(clip.sourceIn)||0,sourceOut=Number(clip.sourceOut)||sourceIn+clip.duration;
        player.currentTime=sourceIn+offset;
        if(gain)scheduleClipGain(gain.gain,clip,offset,context.currentTime);else player.volume=Math.min(1,volume*audioFadeGainAt(clip,offset));
        player.ontimeupdate=()=>{const local=Math.max(0,player.currentTime-sourceIn);if(!gain)player.volume=Math.min(1,previewAudioVolume(clip)*audioFadeGainAt(clip,local));if(player.currentTime>=sourceOut-.005)player.pause();};
        player.play().catch(()=>{}); audioPlayers.push({player,source,gain,context,clipId:clip.id});
        const remaining=Math.max(0,(sourceOut-player.currentTime)*1000);
        audioTimers.push(setTimeout(()=>player.pause(),remaining+20));
      };
      const delay=Math.max(0,(clip.start-project.playhead)*1000);
      if(delay>0)audioTimers.push(setTimeout(launch,delay));else launch();
    }
  }

  function setPlaying(on){
    if(on && duration()<=0) return;
    playing=on;
    if(on){const restart=hasSequenceRange()&&project.playhead>=project.outPoint?project.inPoint:(project.playhead>=duration()?0:project.playhead);playStartedAt=performance.now(); playStartedTime=restart; project.playhead=restart; startAudioPlayback();startVideoPlayback();tick(); }
    else { cancelAnimationFrame(raf); stopAudioPlayback();stopVideoPlayback(); }
    renderTransport();
  }

  function tick(){
    if(!playing) return;
    const next=playStartedTime+(performance.now()-playStartedAt)/1000;
    const stopAt=hasSequenceRange()?Math.min(duration(),project.outPoint):duration();
    if(next>=stopAt){setPlayhead(stopAt);setPlaying(false);return;}
    project.playhead=clamp(next,0,duration());renderTransport();followPlayhead();if(!clipsAt(next).some(isVideoClip))drawViewer();raf=requestAnimationFrame(tick);
  }

  function openEditor(items=[]){
    if(!open){try{onOpen();}catch(err){console.error('[animatics] board view capture failed',err);}}
    open=true; document.body.classList.add('animatics-open'); root.classList.add('open','panel-open'); root.setAttribute('aria-hidden','false');
    syncActiveTrackTargets();setActiveTool('select');if(!previewZoomLocked)fitPreviewZoom({show:false});
    if(items.length) addItems(items,{append:project.clips.length>0}); else renderAll();
    resizeViewer();
  }

  function closeEditor(){
    if(!open)return;
    if(audioTrimState)finishAudioTrimmer(false);if(inlineTextId)finishInlineTextEdit(false);flushDeferredHistory();open=false;setPlaying(false);
    cancelAnimationFrame(scrubPreviewRaf);scrubPreviewRaf=0;scrubPreviewQueued=false;cancelFramingPreview();viewerDrawToken++;
    if(timelineResizeRaf)cancelAnimationFrame(timelineResizeRaf);timelineResizeRaf=0;timelineResize=null;
    drawMode=false;drawBrushesOpen=false;drawColorOpen=false;drawWidthMenuOpen=false;activeStroke=null;clearActiveDrawingSession();hideDrawSizePreview();framingMode=false;framingDrag=null;textDrag=null;marqueeDrag=null;handPan=null;spaceHand=null;finishPreviewPan();inspectorResize=null;clearTimeout(previewZoomHudTimer);previewZoomHudTimer=0;root.classList.remove('hand-panning','inspector-resizing');$('#anInspectorResizer')?.classList.remove('dragging');$('#anTimelineResizer')?.classList.remove('dragging');$('#anMarquee').classList.remove('show');if(dragging)clearTimelineDrag(true);document.body.classList.remove('animatics-open');root.classList.remove('open');root.setAttribute('aria-hidden','true');canvas.parentElement.classList.remove('framing');
    // Pausing alone leaves Chromium decoder buffers and GPU textures resident.
    // Keep the source Blob URLs/project intact, but recreate decoders and the
    // preview backing store next time Animatics opens.
    releaseVideoElements();releaseAudioPlaybackContext();canvas.width=1;canvas.height=1;
    try{onClose();}catch(err){console.error('[animatics] board return recovery failed',err);}
  }

  function resizeViewer({redraw=true}={}){
    const shell=canvas.parentElement,viewport=shell.parentElement;
    const availableW=Math.min(960,viewport.clientWidth),availableH=Math.max(1,viewport.clientHeight);
    if(!availableW||!availableH)return;
    const [rw,rh]=ASPECT_RATIOS[project.aspect]||ASPECT_RATIOS['16:9'];
    const ratio=rw/rh; let w=availableW,h=w/ratio;
    if(h>availableH){h=availableH;w=h*ratio;}
    shell.style.width=`${Math.floor(w)}px`;shell.style.height=`${Math.floor(h)}px`;
    canvas.style.width='100%';canvas.style.height='100%';
    if(!previewZoomLocked&&previewZoom!==1)fitPreviewZoom({show:false});else syncPreviewZoomUi();
    if(redraw){drawViewer();positionInlineTextEditor();}
  }

  function paintTimelineResize({redraw=false}={}){
    if(timelineResizeRaf){cancelAnimationFrame(timelineResizeRaf);timelineResizeRaf=0;}
    if(!timelineResize)return;
    project.timelineHeight=timelineResize.nextHeight;
    applyTimelineHeight();
    resizeViewer({redraw});
  }

  function scheduleTimelineResize(height){
    if(!timelineResize)return;
    timelineResize.nextHeight=height;
    if(timelineResizeRaf)return;
    timelineResizeRaf=requestAnimationFrame(()=>{timelineResizeRaf=0;paintTimelineResize();});
  }

  function setActiveTool(tool){
    clearRazorGuide();
    activeTool=['select','text','razor','hand'].includes(tool)?tool:'select';
    if(activeTool!=='select'&&selectedGap){selectedGap=null;renderTimeline();}
    root.classList.toggle('tool-select',activeTool==='select');root.classList.toggle('tool-text',activeTool==='text');root.classList.toggle('tool-razor',activeTool==='razor');root.classList.toggle('tool-hand',activeTool==='hand');
    root.querySelectorAll('[data-an-tool]').forEach(button=>{
      const current=button.dataset.anTool===activeTool;
      button.classList.toggle('on',current);button.setAttribute('aria-pressed',String(current));
    });
    if(!drawMode&&!framingMode)canvas.style.cursor='';
  }

  function removeTimelineIds(ids){
    const removedIds=ids instanceof Set?new Set(ids):new Set(ids||[]);if(!removedIds.size)return 0;
    if(playing)setPlaying(false);
    const removedVideo=project.clips.filter(c=>removedIds.has(c.id)&&isVideoClip(c)),removedAudio=project.audio.filter(c=>removedIds.has(c.id));
    const before=project.clips.length+project.texts.length+project.audio.length;
    project.clips=project.clips.filter(c=>!removedIds.has(c.id));project.texts=project.texts.filter(c=>!removedIds.has(c.id));project.audio=project.audio.filter(c=>!removedIds.has(c.id));
    if(!project.texts.length)project.textTrackLocked=false;
    for(const clip of removedVideo){videoElements.get(clip.id)?.pause();videoElements.delete(clip.id);}
    for(const clip of removedAudio)if(!project.audio.some(c=>c.mediaId===clip.mediaId)){audioWaveformCache.delete(clip.mediaId);audioWaveformJobs.delete(clip.mediaId);}
    cleanupTimelineLinks();setTimelineSelection([]);
    return before-(project.clips.length+project.texts.length+project.audio.length);
  }

  function copyTimelineSelection(cut=false){
    const ids=new Set(selectedTimelineIds);if(!ids.size&&primarySelectionId())ids.add(primarySelectionId());
    if(!ids.size){notify(cut?'Select one or more clips to cut':'Select one or more clips to copy');return false;}
    const clipboard=createTimelineClipboard(timelineEntries(),ids,{includeLinked:true});if(!clipboard){notify('Nothing selected to copy');return false;}
    for(const entry of clipboard.entries)rememberMedia(entry.item);timelineClipboard=clipboard;
    if(cut){
      if(clipboard.entries.some(isEntryLocked)){notify('Unlock every linked track before cutting these clips');return false;}
      const removed=removeTimelineIds(new Set(clipboard.entries.map(entry=>entry.item.id)));if(!removed)return false;
      markDirty();renderAll();notify(`Cut ${removed} clip${removed===1?'':'s'}`);return true;
    }
    pruneMediaResources();notify(`Copied ${clipboard.entries.length} clip${clipboard.entries.length===1?'':'s'}`);return true;
  }

  function pasteTimelineSelection(){
    if(!timelineClipboard?.entries?.length){notify('Nothing copied in Animatics');return false;}
    if(playing)setPlaying(false);flushDeferredHistory();syncActiveTrackTargets();
    const at=Math.round(Math.max(0,project.playhead)*project.fps)/project.fps;
    const pasted=pasteTimelineClipboard(timelineClipboard,{start:at,videoTrack:activeVideoTrack,audioTrack:activeAudioTrack,videoTrackCount:project.videoTracks,audioTrackCount:project.audioTracks,maxVideoTracks:MAX_VIDEO_TRACKS,maxAudioTracks:MAX_AUDIO_TRACKS,sequenceEnd:fixedSequenceEnd(),makeId:uid,makeLinkId:uid});
    if(!pasted.ok){notify(pasted.reason==='sequence-end'?'Paste would exceed the fixed sequence':pasted.reason==='track-limit'?'Not enough destination tracks to paste':'Nothing copied in Animatics');return false;}
    if(pasted.entries.some(entry=>isTrackLocked(entry.kind,Number(entry.item.track)||0))){notify('Unlock every destination track before pasting');return false;}
    project.videoTracks=pasted.requiredVideoTracks;project.audioTracks=pasted.requiredAudioTracks;ensureTrackHeightCounts();
    for(const entry of pasted.entries){
      if(entry.kind==='video')project.clips.push(entry.item);else if(entry.kind==='text')project.texts.push(entry.item);else project.audio.push(entry.item);
      rememberMedia(entry.item);
    }
    commitTimelineOverwrite(new Set(pasted.ids));setTimelineSelection(pasted.ids,pasted.ids[0]);markDirty();renderAll();notify(`Pasted ${pasted.ids.length} clip${pasted.ids.length===1?'':'s'} at ${timecode(at,project.fps)}`);return true;
  }

  function deleteSelected(){
    if(selectedGap){closeSelectedTimelineGap();return;}
    const ids=new Set(selectedTimelineIds);if(!ids.size&&primarySelectionId())ids.add(primarySelectionId());if(!ids.size)return;
    if(removeTimelineIds(ids)){markDirty();renderAll();}
  }

  function applySelectedDuration(requestedDuration,{commit=true}={}){
    const selection=[...selectedTimelineIds],primary=primarySelectionId(),ids=new Set(selectedDurationItems().map(item=>item.id));if(!ids.size)return;
    const options={minDuration:1/project.fps,sequenceEnd:fixedSequenceEnd()};
    const visual=applyBatchTimelineDuration(project.clips,ids,requestedDuration,{...options,maxDuration:item=>isVideoClip(item)?Math.max(1/project.fps,item.originalDuration-item.sourceIn):600});
    const audio=applyBatchTimelineDuration(project.audio,ids,requestedDuration,{...options,maxDuration:item=>Math.max(1/project.fps,item.originalDuration-item.sourceIn)});
    project.clips=visual.items;project.audio=audio.items;
    const changed=new Set([...visual.changedIds,...audio.changedIds]);
    const clamped=new Set([...visual.clampedIds,...audio.clampedIds]);
    if(!changed.size){syncInspector();if(clamped.size)notify(`${clamped.size} selected clip${clamped.size===1?' was':'s were'} limited by source or sequence length`);return;}
    project.clips=resolveOverwrite(project.clips,changed,{minDuration:MIN_SHOT_SECONDS,makeId:uid});
    project.audio=resolveOverwrite(project.audio,changed,{minDuration:MIN_SHOT_SECONDS,makeId:uid});
    for(const clip of project.audio)applyNormalizedAudioFades(clip);
    cleanupTimelineLinks();setTimelineSelection(selection,primary);if(commit)markDirty();else deferMarkDirty();renderAll();
    if(clamped.size)notify(`${clamped.size} selected clip${clamped.size===1?' was':'s were'} limited by source or sequence length`);
  }

  function closeSelectedTimelineGap(){
    if(!selectedGap)return false;const state=selectedGap,collection=state.kind==='audio'?project.audio:state.kind==='video'?project.clips:null;if(!collection){selectedGap=null;return false;}
    const current=timelineTrackGaps(collection,state.track,{minDuration:1/project.fps-1e-8}).find(gap=>gapKey(state.kind,gap)===state.key);if(!current){selectedGap=null;renderTimeline();return false;}
    if(state.kind==='audio')project.audio=closeTimelineTrackGap(project.audio,current);else project.clips=closeTimelineTrackGap(project.clips,current);
    selectedGap=null;markDirty();renderAll();notify(`Closed gap on ${state.kind==='audio'?'A':'V'}${state.track+1}`);return true;
  }

  function splitSelected(at=project.playhead){
    const entry=entryById(primarySelectionId());if(!entry){notify('Select a timeline layer first');return false;}
    if(isEntryLocked(entry)){notify('Unlock the track before cutting this clip');return false;}
    if(entry.kind==='video'||entry.kind==='audio'){
      const linked=linkedTimelineIds(timelineMediaItems(),[entry.item.id]);if([...linked].map(entryById).filter(Boolean).some(isEntryLocked)){notify('Unlock every linked track before cutting these clips');return false;}
      const source=[...project.clips.map(item=>({...item,__timelineKind:'video'})),...project.audio.map(item=>({...item,__timelineKind:'audio'}))],result=splitLinkedTimelineItems(source,entry.item.id,at,{minDuration:MIN_SHOT_SECONDS,makeId:uid,makeLinkId:uid});
      if(!result){notify('Move the playhead inside the selected layer');return false;}
      for(let index=0;index<result.splitIds.length;index++){
        const left=result.items.find(item=>item.id===result.splitIds[index]),right=result.items.find(item=>item.id===result.rightIds[index]);
        if(left?.__timelineKind==='audio'){left.fadeOutDuration=0;applyNormalizedAudioFades(left);}
        if(right?.__timelineKind==='audio'){right.fadeInDuration=0;applyNormalizedAudioFades(right);}
      }
      const stripKind=item=>{const {__timelineKind,...clean}=item;return clean;};project.clips=result.items.filter(item=>item.__timelineKind==='video').map(stripKind);project.audio=result.items.filter(item=>item.__timelineKind==='audio').map(stripKind);
      setTimelineSelection(result.rightIds,result.targetRightId);markDirty();renderAll();return true;
    }
    const pieces=splitTimelineItem(entry.item,at,{minDuration:MIN_SHOT_SECONDS,makeId:uid});if(!pieces){notify('Move the playhead inside the selected layer');return false;}
    if(pieces[1].strokes)pieces[1].strokes=structuredClone(pieces[1].strokes);
    const index=entry.collection.findIndex(item=>item.id===entry.item.id);entry.collection.splice(index,1,...pieces);setTimelineSelection([pieces[1].id],pieces[1].id);markDirty();renderAll();return true;
  }

  function addTextAtTime(start,{x=.5,y=.82}={}){
    if(isTrackLocked('text')){notify('T1 is locked');return null;}
    start=Math.round(Math.max(0,start)*project.fps)/project.fps;const textDuration=durationWithinSequence(start,DEFAULT_SHOT_SECONDS,DEFAULT_SHOT_SECONDS);if(!textDuration){notify('The fixed sequence has no room for a text layer here');return null;}const text={id:uid(),track:0,start,duration:textDuration,content:'Text',size:42,color:'#ffffff',fontFamily:DEFAULT_TEXT_FONT_FAMILY,bold:false,italic:false,align:'center',background:false,scale:1,rotation:0,x:clamp(x,0,1),y:clamp(y,0,1)};
    project.texts.push(text);project.playhead=text.start;setTimelineSelection([text.id],text.id);root.querySelector('[data-panel="text"]')?.click();markDirty();renderAll();requestAnimationFrame(()=>beginInlineTextEdit(text));
  }

  function razorTimelineEntry(entry,time){
    if(!entry||isEntryLocked(entry)){if(entry)notify(`${entry.kind==='text'?'T1':`${entry.kind==='audio'?'A':'V'}${(Number(entry.item.track)||0)+1}`} is locked`);return false;}setTimelineSelection([entry.item.id],entry.item.id);project.playhead=Math.round(Math.max(0,time)*project.fps)/project.fps;const didSplit=splitSelected(project.playhead);if(didSplit)notify(`Cut at ${timecode(project.playhead,project.fps)}`);return didSplit;
  }

  function setSequenceIn(){project.inPoint=project.playhead;if(Number.isFinite(project.outPoint)&&project.outPoint<=project.inPoint+MIN_SHOT_SECONDS)project.outPoint=null;markDirty();renderTimeline();notify(`In set to ${timecode(project.inPoint,project.fps)}`);}
  function setSequenceOut(){project.outPoint=project.playhead;if(Number.isFinite(project.inPoint)&&project.inPoint>=project.outPoint-MIN_SHOT_SECONDS)project.inPoint=null;markDirty();renderTimeline();notify(`Out set to ${timecode(project.outPoint,project.fps)}`);}
  function clearSequenceRange(){project.inPoint=null;project.outPoint=null;markDirty();renderTimeline();notify('Sequence range cleared');}

  function syncSequenceModeUi({populate=false}={}){
    const fixed=$('#anSequenceMode').value==='fixed',field=$('#anSequenceDuration'),used=contentDuration();
    field.setAttribute('aria-label',fixed?'Custom sequence duration':'Type a duration to switch from Auto to Custom');
    if(fixed&&populate&&!field.value)field.value=timecode(Math.max(MIN_SHOT_SECONDS,Math.ceil(used*project.fps)/project.fps),project.fps);
    if(!fixed&&populate)field.value='';
  }

  function openSequenceSettings(){
    const used=contentDuration(),fixed=fixedSequenceEnd();
    $('#anSequenceMode').value=fixed===null?'auto':'fixed';$('#anTimelineDisplay').value=project.timelineDisplay;$('#anSequenceDuration').value=fixed===null?'':timecode(fixed,project.fps);$('#anSequenceMinimum').textContent=used>0?`Content ends ${timecode(used,project.fps)}`:'No content yet';syncSequenceModeUi();$('#anSequenceModal').classList.add('open');
  }

  function applySequenceSettings(){
    const fixed=$('#anSequenceMode').value==='fixed',used=contentDuration();let next=null;
    if(fixed){next=parseSequenceTimecode($('#anSequenceDuration').value,project.fps);if(!Number.isFinite(next)||next<MIN_SHOT_SECONDS||next>MAX_SEQUENCE_SECONDS){notify('Enter a duration from one frame up to 24 hours');return;}next=Math.round(next*project.fps)/project.fps;if(next+1e-8<used){notify(`Sequence must be at least ${timecode(used,project.fps)} to preserve existing layers`);return;}}
    project.sequenceDuration=next;project.timelineDisplay=$('#anTimelineDisplay').value==='frames'?'frames':'timecode';if(next!==null&&project.timelineZoom*next>SAFE_INITIAL_TIMELINE_PIXELS)project.timelineZoom=clamp(SAFE_INITIAL_TIMELINE_PIXELS/next,MIN_TIMELINE_ZOOM,MAX_TIMELINE_ZOOM);project.playhead=clamp(project.playhead,0,duration());if(Number.isFinite(project.inPoint)&&project.inPoint>duration())project.inPoint=null;if(Number.isFinite(project.outPoint)&&project.outPoint>duration())project.outPoint=duration();if(Number.isFinite(project.inPoint)&&Number.isFinite(project.outPoint)&&project.outPoint<=project.inPoint+MIN_SHOT_SECONDS)project.outPoint=null;markDirty();renderAll();$('#anSequenceModal').classList.remove('open');notify(next===null?'Sequence follows content':`Sequence fixed at ${timecode(next,project.fps)}`);
  }

  function toggleTimelineDisplay(){project.timelineDisplay=project.timelineDisplay==='frames'?'timecode':'frames';markDirty();renderTimeline();}

  function removeTimelineTrack(kind,track){
    const video=kind==='video',collection=video?project.clips:project.audio,count=video?project.videoTracks:project.audioTracks,label=`${video?'V':'A'}${track+1}`;
    if(!Number.isInteger(track)||track<0||track>=count)return false;
    if(isTrackLocked(kind,track)){notify(`${label} is locked`);return false;}
    if(video&&count<=1){notify('V1 is the required primary video track');return false;}
    const occupied=collection.filter(item=>item.track===track);if(occupied.length){notify(`${label} contains ${occupied.length} layer${occupied.length===1?'':'s'} — move or delete them first`);return false;}
    for(const item of collection)if(item.track>track)item.track--;
    ensureTrackHeightCounts();trackHeights(kind).splice(track,1);if(video){project.videoTrackEnabled.splice(track,1);project.videoTrackLocked.splice(track,1);project.videoTracks--;activeVideoTrack=activeVideoTrack===track?Math.min(track,project.videoTracks-1):activeVideoTrack>track?activeVideoTrack-1:activeVideoTrack;}else{project.audioTrackMuted.splice(track,1);project.audioTrackSolo.splice(track,1);project.audioTrackLocked.splice(track,1);project.audioTracks--;activeAudioTrack=activeAudioTrack===track?Math.min(track,Math.max(0,project.audioTracks-1)):activeAudioTrack>track?activeAudioTrack-1:activeAudioTrack;}markDirty();renderTimeline();notify(`${label} removed`);return true;
  }

  function upsertTextLayer(){
    if(isTrackLocked('text')){notify('T1 is locked');return;}
    const content=$('#anText').value.trim();if(!content){notify('Enter some text first');return;}
    let text=selectedText();
    if(!text){const clip=selectedClip(),start=clip?.start??project.playhead,requested=Number($('#anTextDuration').value)||clip?.duration||DEFAULT_SHOT_SECONDS,textDuration=durationWithinSequence(start,requested,600);if(!textDuration){notify('The fixed sequence has no room for a text layer here');return;}text={id:uid(),track:0,start,duration:textDuration,content,size:42,color:'#ffffff',fontFamily:DEFAULT_TEXT_FONT_FAMILY,bold:false,italic:false,align:'center',background:false,scale:1,rotation:0,x:.5,y:.82};project.texts.push(text);setTimelineSelection([text.id],text.id);}
    text.content=content;text.size=clamp(Number($('#anTextSize').value)||42,8,300);text.color=$('#anTextColor').value;text.fontFamily=normalizeTextFontFamily($('#anTextFont').value);text.bold=$('#anTextBold').classList.contains('on');text.italic=$('#anTextItalic').classList.contains('on');text.align=normalizeTextAlign(root.querySelector('[data-an-text-align].on')?.dataset.anTextAlign);text.background=$('#anTextBackground').classList.contains('on');text.scale=clamp(Number($('#anTextScale').value)/100,.25,4);text.rotation=Math.round(clamp(Number($('#anTextRotation').value)||0,-180,180));text.duration=durationWithinSequence(text.start,Number($('#anTextDuration').value)||DEFAULT_SHOT_SECONDS,600)||text.duration;text.x=clamp(finiteOr(text.x,.5),0,1);text.y=clamp(finiteOr(text.y,.82),0,1);
    project.playhead=clamp(project.playhead,text.start,text.start+text.duration-MIN_SHOT_SECONDS);markDirty();renderAll();root.querySelector('[data-panel="text"]')?.click();
  }

  function updateSelectedTextFromControls(){
    const text=selectedText();if(!text)return;
    text.size=clamp(Number($('#anTextSize').value)||42,8,300);text.color=$('#anTextColor').value;text.fontFamily=normalizeTextFontFamily($('#anTextFont').value);text.bold=$('#anTextBold').classList.contains('on');text.italic=$('#anTextItalic').classList.contains('on');text.align=normalizeTextAlign(root.querySelector('[data-an-text-align].on')?.dataset.anTextAlign);text.background=$('#anTextBackground').classList.contains('on');text.scale=clamp(Number($('#anTextScale').value)/100,.25,4);text.rotation=Math.round(clamp(Number($('#anTextRotation').value)||0,-180,180));text.duration=durationWithinSequence(text.start,Number($('#anTextDuration').value)||DEFAULT_SHOT_SECONDS,600)||text.duration;
    const label=`${Math.round(text.scale*100)}%`;$('#anTextScaleVal').value=label;$('#anTextScaleVal').textContent=label;drawViewerLive();positionInlineTextEditor();
  }

  function trimFrames(seconds){
    return Math.max(0,Math.round(seconds*project.fps));
  }

  function updateAudioTrimUi(){
    const state=audioTrimState;if(!state)return;
    const minStep=1/project.fps;
    state.in=clamp(state.in,0,Math.max(0,state.duration-minStep));
    state.out=clamp(state.out,state.in+minStep,state.duration);
    $('#anTrimInFrames').value=String(trimFrames(state.in));
    $('#anTrimOutFrames').value=String(trimFrames(state.out));
    $('#anTrimInFrames').max=String(Math.max(0,trimFrames(state.duration)-1));
    $('#anTrimOutFrames').max=String(trimFrames(state.duration));
    const frames=Math.max(1,trimFrames(state.out)-trimFrames(state.in));
    $('#anTrimSummary').textContent=`${frames} frame${frames===1?'':'s'} · ${(state.out-state.in).toFixed(2)}s`;
    drawAudioTrimWave();
  }

  function drawAudioTrimWave(){
    const state=audioTrimState;if(!state)return;
    const wave=$('#anTrimWave'),g=wave.getContext('2d'),w=wave.width,h=wave.height;
    g.clearRect(0,0,w,h);g.fillStyle='#0d0f14';g.fillRect(0,0,w,h);
    const startX=state.duration?state.in/state.duration*w:0,endX=state.duration?state.out/state.duration*w:w;
    g.fillStyle='rgba(91,164,255,.13)';g.fillRect(startX,0,Math.max(1,endX-startX),h);
    const peaks=trimWavePeaks.length?trimWavePeaks:Array.from({length:160},(_,i)=>.18+Math.abs(Math.sin(i*.43))*.42);
    g.fillStyle='#6e8199';const barW=w/peaks.length;
    peaks.forEach((peak,i)=>{const bh=Math.max(2,peak*(h*.78));g.fillRect(i*barW,h/2-bh/2,Math.max(1,barW*.58),bh);});
    g.fillStyle='rgba(5,7,10,.66)';g.fillRect(0,0,startX,h);g.fillRect(endX,0,w-endX,h);
    g.fillStyle='#65aaff';g.fillRect(startX-2,0,4,h);g.fillRect(endX-2,0,4,h);
    const current=clamp(Number($('#anTrimPlayer').currentTime)||0,0,state.duration);
    const playX=state.duration?current/state.duration*w:0;g.fillStyle='#ff6b6b';g.fillRect(playX-1,0,2,h);
    $('#anTrimReadout').textContent=timecode(current,project.fps);
  }

  async function decodeAudioWaveform(file,stateUrl){
    try{
      const waveform=await decodeAudioBlob(file);
      if(audioTrimState?.url===stateUrl&&waveform){audioTrimState.waveform=waveform;trimWavePeaks=waveform.peaks;drawAudioTrimWave();}
    }catch(err){console.warn('[animatics] waveform unavailable',err);}
  }

  function finishAudioTrimmer(useAudio){
    const state=audioTrimState,resolve=audioTrimResolve,player=$('#anTrimPlayer');
    if(!state)return;
    player.pause();player.removeAttribute('src');player.load();
    $('#anAudioTrimModal').classList.remove('open');
    const result=useAudio?{file:state.file,url:state.url,duration:state.duration,sourceIn:state.in,sourceOut:state.out,waveform:state.waveform||null}:null;
    if(!useAudio)URL.revokeObjectURL(state.url);
    audioTrimState=null;audioTrimResolve=null;trimWavePeaks=[];trimHandleDrag=null;
    resolve?.(result);
  }

  function openAudioTrimmer(file){
    if(audioTrimState)finishAudioTrimmer(false);
    const url=URL.createObjectURL(file),player=$('#anTrimPlayer');
    audioTrimState={file,url,duration:1,in:0,out:1,playingSelection:false};
    trimWavePeaks=[];$('#anTrimName').textContent=file.name||'Audio';$('#anAudioTrimModal').classList.add('open');
    player.src=url;player.currentTime=0;player.load();updateAudioTrimUi();
    decodeAudioWaveform(file,url);
    player.onloadedmetadata=()=>{
      if(audioTrimState?.url!==url)return;
      const duration=Number.isFinite(player.duration)&&player.duration>MIN_SHOT_SECONDS?player.duration:1;
      audioTrimState.duration=duration;audioTrimState.in=0;audioTrimState.out=duration;updateAudioTrimUi();
    };
    player.onerror=()=>{if(audioTrimState?.url===url)updateAudioTrimUi();};
    return new Promise(resolve=>{audioTrimResolve=resolve;});
  }

  async function addAudioFiles(files,{track=null,start=project.playhead}={}){
    const explicitTrack=track!==null&&track!==undefined&&Number.isInteger(Number(track)),requestedTrack=explicitTrack?clamp(Math.round(Number(track)),0,MAX_AUDIO_TRACKS-1):null,list=[...files].filter(isAudioFile).slice(0,explicitTrack?50:Math.max(0,MAX_AUDIO_TRACKS-project.audioTracks));
    if(!list.length){notify('Drop one or more audio files');return 0;}
    if(explicitTrack&&requestedTrack<project.audioTracks&&isTrackLocked('audio',requestedTrack)){notify(`A${requestedTrack+1} is locked`);return 0;}
    let added=0,cursor=Math.max(0,Number(start)||0);const addedIds=[];
    for(const file of list){
      const trimmed=await openAudioTrimmer(file);if(!trimmed)continue;
      const destination=explicitTrack?requestedTrack:project.audioTracks;if(destination>=MAX_AUDIO_TRACKS){URL.revokeObjectURL(trimmed.url);break;}project.audioTracks=Math.max(project.audioTracks,destination+1);ensureTrackHeightCounts();
      const clipStart=explicitTrack?cursor:Math.max(0,Number(start)||project.playhead),requested=trimmed.sourceOut-trimmed.sourceIn,duration=durationWithinSequence(clipStart,requested,requested);if(!duration){URL.revokeObjectURL(trimmed.url);notify('The fixed sequence has no room for audio here');continue;}const clip={id:uid(),mediaId:uid(),track:destination,start:clipStart,duration,sourceIn:trimmed.sourceIn,sourceOut:trimmed.sourceIn+duration,originalDuration:trimmed.duration,name:file.name,blob:file,url:trimmed.url,volume:1,fadeInDuration:0,fadeOutDuration:0,fadeInCurve:'constant-power',fadeOutCurve:'constant-power',fadeInShape:0,fadeOutShape:0,type:file.type||'audio/mpeg',needsRelink:false};activeAudioTrack=destination;
      project.audio.push(clip);addedIds.push(clip.id);if(trimmed.waveform)audioWaveformCache.set(clip.mediaId,trimmed.waveform);setTimelineSelection([clip.id],clip.id);if(explicitTrack)cursor+=duration;
      added++;
    }
    if(added){if(explicitTrack)commitTimelineOverwrite(new Set(addedIds));markDirty();renderAll();notify(`Added ${added} audio clip${added===1?'':'s'}`);}return added;
  }

  function pointerTime(event,lane){ const r=lane.getBoundingClientRect(); const px=Number($('#anZoom').value)||90; return Math.max(0,(event.clientX-r.left)/px); }

  function clearRazorGuide(){
    razorHoverClip?.classList.remove('razor-hover');razorHoverClip=null;$('#anRazorGuide')?.classList.remove('show');
  }

  function razorTargetAt(event){
    if(activeTool!=='razor')return null;
    const clipEl=event.target.closest?.('.an-clip'),lane=clipEl?.closest('.an-track-lane');if(!clipEl||!lane)return;
    const entry=entryById(clipEl.dataset.clip);if(!entry||isEntryLocked(entry))return;
    const time=Math.round(pointerTime(event,lane)*project.fps)/project.fps,start=Number(entry.item.start)||0,end=start+(Number(entry.item.duration)||0);
    if(time<=start+MIN_SHOT_SECONDS||time>=end-MIN_SHOT_SECONDS)return;
    return {clipEl,lane,entry,time};
  }

  function updateRazorGuide(event){
    const target=razorTargetAt(event);if(!target){clearRazorGuide();return;}
    const {clipEl,lane,time}=target,guide=$('#anRazorGuide'),containerRect=guide.parentElement.getBoundingClientRect(),clipRect=clipEl.getBoundingClientRect(),laneRect=lane.getBoundingClientRect(),px=Number($('#anZoom').value)||90;
    if(razorHoverClip!==clipEl){razorHoverClip?.classList.remove('razor-hover');clipEl.classList.add('razor-hover');razorHoverClip=clipEl;}
    guide.style.left=`${laneRect.left-containerRect.left+time*px}px`;guide.style.top=`${clipRect.top-containerRect.top+3}px`;guide.style.height=`${Math.max(8,clipRect.height-6)}px`;guide.querySelector('span').textContent=timecode(time,project.fps);guide.classList.add('show');
  }

  function updateSequenceRangeVisuals(){
    const px=Number($('#anZoom').value)||90;
    const inMarker=grid.querySelector('[data-sequence-marker="in"]'),outMarker=grid.querySelector('[data-sequence-marker="out"]'),range=grid.querySelector('.an-sequence-range');
    if(inMarker)inMarker.style.setProperty('--an-marker-x',`${project.inPoint*px}px`);if(outMarker)outMarker.style.setProperty('--an-marker-x',`${project.outPoint*px}px`);
    if(range&&hasSequenceRange()){range.style.setProperty('--an-in-x',`${project.inPoint*px}px`);range.style.setProperty('--an-range-w',`${(project.outPoint-project.inPoint)*px}px`);}
    syncPlayheadVisibility();
  }

  function setSequenceMarkerValue(kind,value){
    const end=Math.max(0,duration());value=clamp(value,0,end);
    if(kind==='in'){if(Number.isFinite(project.outPoint))value=Math.min(value,Math.max(0,project.outPoint-MIN_SHOT_SECONDS));project.inPoint=value;}
    else{if(Number.isFinite(project.inPoint))value=Math.max(value,Math.min(end,project.inPoint+MIN_SHOT_SECONDS));project.outPoint=value;}
    updateSequenceRangeVisuals();
  }

  function clearTimelineDrag(cancel=false){
    if(!dragging)return;const state=dragging;
    if(cancel)for(const original of state.originals)Object.assign(original.item,original.values);
    for(const visual of state.visuals){visual.sourceEl.classList.remove('dragging-source');visual.ghost.remove();}state.hoverLane?.classList.remove('an-lane-hover');
    grid.querySelector('.an-snap-guide')?.classList.remove('show');dragging=null;
  }

  function beginTimelineDragVisuals(state){
    if(!state||state.trimEdge||state.visuals.length)return;
    for(const original of state.originals){
      const el=grid.querySelector(`[data-clip="${CSS.escape(original.item.id)}"]`);if(!el)continue;
      const rect=el.getBoundingClientRect(),ghost=el.cloneNode(true);ghost.classList.add('an-drag-ghost');ghost.classList.remove('dragging-source','on','primary');
      Object.assign(ghost.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});root.append(ghost);state.visuals.push({original,sourceEl:el,ghost});el.classList.add('dragging-source');
    }
    state.hoverLane?.classList.add('an-lane-hover');
  }

  function panelForKind(kind){root.querySelector(`[data-panel="${kind==='video'?'clip':kind}"]`)?.click();}

  function showSnapGuide(time){
    const guide=grid.querySelector('.an-snap-guide');if(!guide)return;
    guide.classList.toggle('show',Number.isFinite(time));if(Number.isFinite(time)){guide.style.transform=`translateX(${time*(Number($('#anZoom').value)||90)}px)`;guide.querySelector('span').textContent=timecode(time,project.fps);}
  }

  function commitTimelineOverwrite(movedIds=selectedTimelineIds){
    const moved=new Set(movedIds),beforeClips=[...project.clips],beforeAudio=[...project.audio];
    project.clips=resolveOverwrite(project.clips,moved,{minDuration:MIN_SHOT_SECONDS,makeId:uid});
    project.texts=resolveOverwrite(project.texts,moved,{minDuration:MIN_SHOT_SECONDS,makeId:uid});
    project.audio=resolveOverwrite(project.audio,moved,{minDuration:MIN_SHOT_SECONDS,makeId:uid});
    cleanupTimelineLinks();
    const clipIds=new Set(project.clips.map(c=>c.id));for(const clip of beforeClips)if(!clipIds.has(clip.id)){videoElements.get(clip.id)?.pause();videoElements.delete(clip.id);}
    for(const clip of beforeAudio)if(!project.audio.some(c=>c.id===clip.id)&&!project.audio.some(c=>c.mediaId===clip.mediaId)){audioWaveformCache.delete(clip.mediaId);audioWaveformJobs.delete(clip.mediaId);}
  }

  function movedTouchesLockedTrack(ids){
    for(const id of ids||[]){const entry=entryById(id);if(entry&&isEntryLocked(entry))return true;}
    return false;
  }

  function timelineMarqueeSurface(e){
    if(!['select','razor'].includes(activeTool))return null;
    const lanes=[...grid.querySelectorAll('.an-track-lane')];if(!lanes.length)return null;
    const first=lanes[0].getBoundingClientRect(),scrollRect=scroll.getBoundingClientRect();
    const bounds={left:first.left,right:first.right,top:first.top,bottom:scrollRect.bottom};
    if(e.clientX<bounds.left||e.clientX>bounds.right||e.clientY<bounds.top||e.clientY>bounds.bottom)return null;
    return {lane:lanes[0],bounds};
  }

  function timelineLaneAtPointer(e,kind,fallback=null){
    const direct=document.elementFromPoint(e.clientX,e.clientY)?.closest?.('.an-track-lane');if(direct?.dataset.kind===kind)return direct;
    const byY=[...grid.querySelectorAll(`.an-track-lane[data-kind="${kind}"]`)].find(lane=>{const rect=lane.getBoundingClientRect();return e.clientY>=rect.top&&e.clientY<=rect.bottom;});
    if(byY)return byY;
    const bounds=scroll.getBoundingClientRect();return e.clientY>=bounds.top&&e.clientY<=bounds.bottom?fallback:null;
  }

  function beginMarquee(e,lane,bounds=null,captureEl=lane,startPoint=null){
    selectedGap=null;
    const additive=e.shiftKey||e.ctrlKey||e.metaKey,box=$('#anMarquee');
    const originX=startPoint?.x??e.clientX,originY=startPoint?.y??e.clientY,startX=bounds?clamp(originX,bounds.left,bounds.right):originX,startY=bounds?clamp(originY,bounds.top,bounds.bottom):originY;
    marqueeDrag={startX,startY,x:startX,y:startY,base:new Set(selectedTimelineIds),mode:additive?(e.ctrlKey||e.metaKey?'toggle':'add'):'replace',lane,bounds,moved:false,pointerId:e.pointerId};
    box.style.left=`${startX}px`;box.style.top=`${startY}px`;box.style.width='0px';box.style.height='0px';box.classList.add('show');captureEl.setPointerCapture?.(e.pointerId);e.preventDefault();
  }

  function updateMarquee(e){
    if(!marqueeDrag)return;const state=marqueeDrag,box=$('#anMarquee'),scrollRect=scroll.getBoundingClientRect();state.x=state.bounds?clamp(e.clientX,state.bounds.left,state.bounds.right):e.clientX;state.y=state.bounds?clamp(e.clientY,state.bounds.top,state.bounds.bottom):e.clientY;state.moved=state.moved||Math.hypot(state.x-state.startX,state.y-state.startY)>3;
    if(e.clientX>scrollRect.right-24)scroll.scrollLeft+=16;else if(e.clientX<scrollRect.left+TRACK_LABEL_WIDTH+24)scroll.scrollLeft=Math.max(0,scroll.scrollLeft-16);
    if(e.clientY>scrollRect.bottom-22)scroll.scrollTop+=12;else if(e.clientY<scrollRect.top+22)scroll.scrollTop=Math.max(0,scroll.scrollTop-12);
    const left=Math.min(state.startX,state.x),top=Math.min(state.startY,state.y);box.style.left=`${left}px`;box.style.top=`${top}px`;box.style.width=`${Math.abs(state.x-state.startX)}px`;box.style.height=`${Math.abs(state.y-state.startY)}px`;
    const entries=[...grid.querySelectorAll('.an-clip')].map(el=>({id:el.dataset.clip,rect:el.getBoundingClientRect()}));
    setTimelineSelection(marqueeSelection({x1:state.startX,y1:state.startY,x2:state.x,y2:state.y},entries,state.base,state.mode),primarySelectionId());
    for(const el of grid.querySelectorAll('.an-clip'))el.classList.toggle('on',selectedTimelineIds.has(el.dataset.clip));syncInspector();
  }

  function finishMarquee(){
    if(!marqueeDrag)return;const state=marqueeDrag;$('#anMarquee').classList.remove('show');marqueeDrag=null;
    if(!state.moved){if(state.mode==='replace')setTimelineSelection([]);scrubTo(pointerTime({clientX:state.x},state.lane));renderTimeline();}else{renderTimeline();syncInspector();drawViewer();}
  }

  grid.addEventListener('pointerdown',e=>{
    const temporaryHand=e.button===1,persistentHand=activeTool==='hand'&&e.button===0;
    if(temporaryHand||persistentHand){if(temporaryHand)setActiveTool('hand');handPan={startX:e.clientX,startY:e.clientY,startScrollLeft:scroll.scrollLeft,startScrollTop:scroll.scrollTop,temporary:temporaryHand,pointerId:e.pointerId};root.classList.add('hand-panning');grid.setPointerCapture?.(e.pointerId);e.preventDefault();return;}
    const fadeHandle=e.target.closest('[data-audio-fade]');if(fadeHandle){const clipEl=fadeHandle.closest('.an-clip'),clip=project.audio.find(item=>item.id===clipEl?.dataset.clip);if(!clip)return;if(isTrackLocked('audio',clip.track)){notify(`A${clip.track+1} is locked`);return;}const side=fadeHandle.dataset.audioFade==='out'?'Out':'In',fades=applyNormalizedAudioFades(clip),startDuration=fades[`fade${side}Duration`];setTimelineSelection([clip.id],clip.id);audioFadeDrag={clip,clipEl,side,startX:e.clientX,startDuration,pendingDuration:startDuration,otherDuration:fades[`fade${side==='In'?'Out':'In'}Duration`],pointerId:e.pointerId};grid.setPointerCapture?.(e.pointerId);syncInspector();e.preventDefault();e.stopPropagation();return;}
    const trackResizeHandle=e.target.closest('.an-track-resize');
    if(trackResizeHandle){const kind=trackResizeHandle.dataset.trackResize,track=Number(trackResizeHandle.dataset.track);trackResize={kind,track,startY:e.clientY,startHeight:trackHeight(kind,track),pointerId:e.pointerId};trackResizeHandle.classList.add('dragging');grid.setPointerCapture?.(e.pointerId);e.preventDefault();return;}
    const trackGrip=e.target.closest('.an-track-grip');
    if(trackGrip){const kind=trackGrip.dataset.trackMove,from=Number(trackGrip.dataset.track);trackReorder={kind,from,to:from,pointerId:e.pointerId};grid.setPointerCapture?.(e.pointerId);grid.querySelector(`.an-track-row[data-track-kind="${kind}"][data-track-index="${from}"]`)?.classList.add('reorder-source');e.preventDefault();return;}
    const sequenceMarker=e.target.closest('.an-sequence-marker');
    if(sequenceMarker){if(playing)setPlaying(false);sequenceMarkerDrag={kind:sequenceMarker.dataset.sequenceMarker,el:sequenceMarker,pointerId:e.pointerId};sequenceMarker.setPointerCapture?.(e.pointerId);e.preventDefault();return;}
    const gapEl=e.target.closest('.an-gap');const clipEl=e.target.closest('.an-clip'); const lane=e.target.closest('.an-track-lane');
    if(gapEl&&activeTool==='select'){
      const gapKind=gapEl.dataset.kind,gapTrack=Number(gapEl.dataset.track);if(isTrackLocked(gapKind,gapTrack)){notify(`${gapKind==='audio'?'A':'V'}${gapTrack+1} is locked`);e.preventDefault();return;}
      if(playing)setPlaying(false);const surface=timelineMarqueeSurface(e);gapPress={key:gapEl.dataset.gap,kind:gapEl.dataset.kind,track:Number(gapEl.dataset.track),start:Number(gapEl.dataset.start),end:Number(gapEl.dataset.end),startX:e.clientX,startY:e.clientY,lane,bounds:surface?.bounds||null,pointerId:e.pointerId};grid.setPointerCapture?.(e.pointerId);e.preventDefault();return;
    }
    const razorTarget=activeTool==='razor'?razorTargetAt(e):null;if(activeTool==='razor'&&!razorTarget)clearRazorGuide();
    if(!clipEl){
      const ruler=e.target.closest('.an-ruler');
      if(ruler){
        if(playing)setPlaying(false);
        scrubbing={target:ruler,pointerId:e.pointerId};
        ruler.setPointerCapture?.(e.pointerId);
        scrubTo(pointerTime(e,ruler));
        e.preventDefault();
        return;
      }
      if(activeTool==='text'){if(lane)scrubTo(pointerTime(e,lane));e.preventDefault();return;}
      const surface=e.target.closest('[data-add-track],.an-track-label')?null:timelineMarqueeSurface(e);
      if(surface){if(playing)setPlaying(false);beginMarquee(e,surface.lane,surface.bounds,grid);return;}
      if(lane){if(playing)setPlaying(false);setTimelineSelection([]);scrubTo(pointerTime(e,lane));renderTimeline();}
      return;
    }
    const kind=clipEl.dataset.kind||'video';const audio=kind==='audio',text=kind==='text';const collection=audio?project.audio:text?project.texts:project.clips; const clip=collection.find(c=>c.id===clipEl.dataset.clip); if(!clip)return;
    if(isTrackLocked(kind,Number(clip.track)||0)){notify(`${kind==='text'?'T1':`${kind==='audio'?'A':'V'}${(Number(clip.track)||0)+1}`} is locked`);e.preventDefault();return;}
    selectedGap=null;
    if(activeTool==='razor'&&razorTarget){clearRazorGuide();razorTimelineEntry({item:clip,kind,collection},razorTarget.time);e.preventDefault();return;}
    if(activeTool==='text'){scrubTo(pointerTime(e,lane));e.preventDefault();return;}
    const trimEdge=e.target.dataset.trim||null,modifier=e.shiftKey||e.ctrlKey||e.metaKey;
    if(trimEdge)setTimelineSelection([clip.id],clip.id);else if(modifier)selectTimelineEntry(clip.id,{add:e.shiftKey,toggle:e.ctrlKey||e.metaKey});else if(!selectedTimelineIds.has(clip.id))setTimelineSelection([clip.id],clip.id);else syncPrimarySelection(clip.id);
    if(!selectedTimelineIds.has(clip.id)){renderTimeline();syncInspector();return;}
    panelForKind(kind);syncInspector();drawViewer();
    const movedIds=trimEdge?new Set([clip.id]):linkedTimelineIds(timelineMediaItems(),selectedTimelineIds),selectedEntries=trimEdge?[{item:clip,kind,collection}]:[...movedIds].map(entryById).filter(Boolean),visuals=[];
    if(selectedEntries.some(isEntryLocked)){notify('Unlock every linked track before moving these clips');return;}
    const originals=selectedEntries.map(entry=>({item:entry.item,kind:entry.kind,values:{start:entry.item.start,duration:entry.item.duration,track:entry.item.track,sourceIn:entry.item.sourceIn,sourceOut:entry.item.sourceOut,...(entry.kind==='audio'?normalizedAudioFades(entry.item):{})}}));
    const snapStationary=[...project.clips.filter(item=>!movedIds.has(item.id)).map(item=>({start:item.start,duration:item.duration,track:item.track,kind:'video'})),...project.audio.filter(item=>!movedIds.has(item.id)).map(item=>({start:item.start,duration:item.duration,track:item.track,kind:'audio'}))];
    dragging={clip,kind,trimEdge,movedIds,startX:e.clientX,startY:e.clientY,startScrollLeft:scroll.scrollLeft,startTrack:Number(clip.track)||0,trackDelta:0,sequenceEnd:duration(),originals,visuals,snapStationary,hoverLane:lane,moved:false};
    clipEl.setPointerCapture(e.pointerId); e.preventDefault();
  });
  grid.addEventListener('pointermove',e=>{
    if(handPan){if(spaceHand&&Math.hypot(e.clientX-handPan.startX,e.clientY-handPan.startY)>2)spaceHand.used=true;scroll.scrollLeft=handPan.startScrollLeft-(e.clientX-handPan.startX)*1.35;scroll.scrollTop=handPan.startScrollTop-(e.clientY-handPan.startY)*1.35;syncPlayheadVisibility();return;}
    if(audioFadeDrag){const state=audioFadeDrag,px=Number($('#anZoom').value)||90,delta=(e.clientX-state.startX)/px*(state.side==='In'?1:-1);state.pendingDuration=clamp(state.startDuration+delta,0,Math.max(0,state.clip.duration-state.otherDuration));scheduleAudioFadeDragPaint();return;}
    if(trackResize){const height=clamp(trackResize.startHeight+e.clientY-trackResize.startY,MIN_TRACK_HEIGHT,MAX_TRACK_HEIGHT);setTrackHeight(trackResize.kind,trackResize.track,height);const row=grid.querySelector(`.an-track-row[data-track-kind="${trackResize.kind}"][data-track-index="${trackResize.track}"]`);if(row){row.style.setProperty('--an-track-height',`${height}px`);row.classList.toggle('compact',height<34);row.querySelector('.an-track-resize')?.classList.add('dragging');}return;}
    if(trackReorder){const hit=document.elementFromPoint(e.clientX,e.clientY)?.closest?.(`.an-track-row[data-track-kind="${trackReorder.kind}"]`);if(hit)trackReorder.to=Number(hit.dataset.trackIndex);for(const row of grid.querySelectorAll(`.an-track-row[data-track-kind="${trackReorder.kind}"]`)){const index=Number(row.dataset.trackIndex);row.classList.toggle('reorder-source',index===trackReorder.from);row.classList.toggle('reorder-target',index===trackReorder.to&&index!==trackReorder.from);}return;}
    if(activeTool==='razor'&&!sequenceMarkerDrag&&!scrubbing&&!marqueeDrag&&!dragging)updateRazorGuide(e);
    if(gapPress){if(Math.hypot(e.clientX-gapPress.startX,e.clientY-gapPress.startY)<=3)return;const state=gapPress;gapPress=null;beginMarquee(e,state.lane,state.bounds,grid,{x:state.startX,y:state.startY});updateMarquee(e);return;}
    if(sequenceMarkerDrag){setSequenceMarkerValue(sequenceMarkerDrag.kind,pointerTime(e,grid.querySelector('.an-ruler')));return;}
    if(scrubbing){scrubTo(pointerTime(e,scrubbing.target));return;}
    if(marqueeDrag){updateMarquee(e);return;}
    if(!dragging)return; const px=Number($('#anZoom').value)||90; const step=e.shiftKey?1/project.fps:.05;
    if(!dragging.moved&&Math.hypot(e.clientX-dragging.startX,e.clientY-dragging.startY)<2)return;dragging.moved=true;if(!dragging.trimEdge)beginTimelineDragVisuals(dragging);
    const scrollRect=scroll.getBoundingClientRect();if(e.clientX>scrollRect.right-24)scroll.scrollLeft+=16;else if(e.clientX<scrollRect.left+TRACK_LABEL_WIDTH+24)scroll.scrollLeft=Math.max(0,scroll.scrollLeft-16);
    let delta=Math.round((((e.clientX-dragging.startX)+(scroll.scrollLeft-dragging.startScrollLeft))/px)/step)*step;
    if(dragging.trimEdge==='right'){
      const original=dragging.originals[0],sourceBounded=dragging.kind==='audio'||isVideoClip(dragging.clip),sourceMax=sourceBounded?Math.max(MIN_SHOT_SECONDS,(dragging.clip.originalDuration||original.values.sourceOut)-original.values.sourceIn):600,maxDuration=Math.min(sourceMax,fixedSequenceEnd()===null?sourceMax:Math.max(MIN_SHOT_SECONDS,fixedSequenceEnd()-original.values.start));
      let end=original.values.start+clamp(original.values.duration+delta,MIN_SHOT_SECONDS,maxDuration);if(project.timelineSnap){const candidates=[0,dragging.sequenceEnd,project.playhead,project.inPoint,project.outPoint,...timelineMediaEdgeTimes([dragging.clip.id])].filter(Number.isFinite);let best=null;for(const candidate of candidates)if(Math.abs(candidate-end)<=8/px&&(best===null||Math.abs(candidate-end)<Math.abs(best-end)))best=candidate;if(best!==null){end=best;showSnapGuide(best);}else showSnapGuide(null);}
      dragging.clip.duration=clamp(end-original.values.start,MIN_SHOT_SECONDS,maxDuration);if(sourceBounded)dragging.clip.sourceOut=original.values.sourceIn+dragging.clip.duration;
    }else if(dragging.trimEdge==='left'){
      const original=dragging.originals[0],sourceBounded=dragging.kind==='audio'||isVideoClip(dragging.clip),minDelta=sourceBounded?Math.max(-original.values.sourceIn,-original.values.start):-original.values.start;delta=clamp(delta,minDelta,original.values.duration-MIN_SHOT_SECONDS);
      let start=original.values.start+delta;if(project.timelineSnap){const candidates=[0,dragging.sequenceEnd,project.playhead,project.inPoint,project.outPoint,...timelineMediaEdgeTimes([dragging.clip.id])].filter(Number.isFinite);let best=null;for(const candidate of candidates)if(Math.abs(candidate-start)<=8/px&&(best===null||Math.abs(candidate-start)<Math.abs(best-start)))best=candidate;if(best!==null){start=best;delta=start-original.values.start;showSnapGuide(best);}else showSnapGuide(null);}
      delta=clamp(start-original.values.start,minDelta,original.values.duration-MIN_SHOT_SECONDS);start=original.values.start+delta;dragging.clip.start=start;dragging.clip.duration=original.values.duration-delta;if(sourceBounded){dragging.clip.sourceIn=original.values.sourceIn+delta;dragging.clip.sourceOut=original.values.sourceOut;}
    }else {
      const minStart=Math.min(...dragging.originals.map(o=>o.values.start));delta=Math.max(-minStart,delta);const pointerLane=timelineLaneAtPointer(e,dragging.kind,dragging.hoverLane),sameKind=dragging.originals.filter(original=>original.kind===dragging.kind),trackCount=dragging.kind==='video'?project.videoTracks:dragging.kind==='audio'?project.audioTracks:1;let requestedTrackDelta=dragging.trackDelta;
      if(pointerLane)requestedTrackDelta=Number(pointerLane.dataset.track)-dragging.startTrack;
      const trackDelta=constrainedTrackDelta(sameKind.map(original=>original.values),requestedTrackDelta,trackCount);dragging.trackDelta=trackDelta;
      const primaryOriginal=dragging.originals.find(o=>o.item===dragging.clip),primaryTargetTrack=(primaryOriginal?.values.track||0)+trackDelta,targetLane=grid.querySelector(`.an-track-lane[data-kind="${dragging.kind}"][data-track="${primaryTargetTrack}"]`);
      if(targetLane&&dragging.hoverLane!==targetLane){dragging.hoverLane?.classList.remove('an-lane-hover');dragging.hoverLane=targetLane;targetLane.classList.add('an-lane-hover');}
      if(project.timelineSnap){const moving=dragging.originals.map(original=>({...original.values,kind:original.kind,targetTrack:(original.values.track||0)+(original.kind===dragging.kind?trackDelta:0)})),snap=snappedMoveDelta({moving,stationary:dragging.snapStationary,proposedDelta:delta,threshold:8/px,extraTimes:[0,dragging.sequenceEnd,project.playhead,project.inPoint,project.outPoint]});delta=snap.delta;showSnapGuide(snap.guide); }else showSnapGuide(null);
      const sequenceEnd=fixedSequenceEnd();if(sequenceEnd!==null){const selectedEnd=Math.max(...dragging.originals.map(o=>o.values.start+o.values.duration));delta=Math.min(delta,sequenceEnd-selectedEnd);}
      for(const original of dragging.originals){original.item.start=Math.max(0,original.values.start+delta);if(original.kind===dragging.kind)original.item.track=(original.values.track||0)+trackDelta;}
      for(const visual of dragging.visuals){const {original,ghost}=visual,visualLane=grid.querySelector(`.an-track-lane[data-kind="${original.kind}"][data-track="${original.item.track||0}"]`);if(!visualLane)continue;const laneRect=visualLane.getBoundingClientRect();ghost.style.left=`${laneRect.left+original.item.start*px}px`;ghost.style.top=`${laneRect.top+4}px`;}
    }
    if(dragging.trimEdge&&dragging.kind==='audio')applyNormalizedAudioFades(dragging.clip);
    if(dragging.trimEdge){const el=grid.querySelector(`[data-clip="${CSS.escape(dragging.clip.id)}"]`);if(el){el.style.left=`${dragging.clip.start*px}px`;el.style.width=`${Math.max(16,dragging.clip.duration*px)}px`;const dur=el.querySelector('.an-clip-dur');if(dur)dur.textContent=clipDurationLabel(dragging.clip);if(dragging.kind==='audio')updateAudioFadeVisual(el,dragging.clip,px);}}
    if(dragging.trimEdge)drawViewer();
  });
  grid.addEventListener('pointerup',()=>{if(audioFadeDrag){flushAudioFadeDrag(true);audioFadeDrag=null;markDirty();renderAll();return;}if(handPan){const temporary=handPan.temporary;handPan=null;root.classList.remove('hand-panning');if(temporary)setActiveTool('select');return;}if(trackResize){const state=trackResize,changed=Math.abs(trackHeight(state.kind,state.track)-state.startHeight)>1e-8;trackResize=null;if(changed){markDirty();renderTimeline();}else grid.querySelector(`[data-track-resize="${state.kind}"][data-track="${state.track}"]`)?.classList.remove('dragging');return;}if(trackReorder){const state=trackReorder;trackReorder=null;if(moveTimelineTrack(state.kind,state.from,state.to)){markDirty();renderAll();notify(`Moved ${state.kind==='video'?'video':'audio'} track to ${state.kind==='video'?'V':'A'}${state.to+1}`);}else for(const row of grid.querySelectorAll('.an-track-row'))row.classList.remove('reorder-source','reorder-target');return;}if(gapPress){const state=gapPress;gapPress=null;setTimelineSelection([]);selectedGap={key:state.key,kind:state.kind,track:state.track,start:state.start,end:state.end};renderTimeline();syncInspector();return;}if(sequenceMarkerDrag){sequenceMarkerDrag=null;markDirty();renderTimeline();}if(scrubbing)scrubbing=null;if(marqueeDrag)finishMarquee();if(dragging){const changed=dragging.moved,movedIds=dragging.movedIds;if(changed&&movedTouchesLockedTrack(movedIds)){clearTimelineDrag(true);notify('Unlock the destination track before moving clips');renderAll();return;}if(changed)commitTimelineOverwrite(movedIds);clearTimelineDrag(false);if(changed)markDirty();renderAll();}});
  grid.addEventListener('pointercancel',()=>{if(audioFadeDrag){const state=audioFadeDrag;if(audioFadeDragRaf){cancelAnimationFrame(audioFadeDragRaf);audioFadeDragRaf=0;}state.clip[`fade${state.side}Duration`]=state.startDuration;applyNormalizedAudioFades(state.clip);updateActiveAudioGain(state.clip);audioFadeDrag=null;renderAll();}if(handPan){const temporary=handPan.temporary;handPan=null;root.classList.remove('hand-panning');if(temporary)setActiveTool('select');}if(trackResize){setTrackHeight(trackResize.kind,trackResize.track,trackResize.startHeight);trackResize=null;renderTimeline();}if(trackReorder){trackReorder=null;for(const row of grid.querySelectorAll('.an-track-row'))row.classList.remove('reorder-source','reorder-target');}gapPress=null;if(sequenceMarkerDrag){sequenceMarkerDrag=null;renderTimeline();}scrubbing=null;if(marqueeDrag){$('#anMarquee').classList.remove('show');marqueeDrag=null;renderTimeline();}if(dragging){clearTimelineDrag(true);renderAll();}});
  grid.addEventListener('pointerleave',clearRazorGuide);
  grid.addEventListener('keydown',e=>{const resize=e.target.closest?.('[data-track-resize]');if(resize&&['ArrowUp','ArrowDown','Home'].includes(e.key)){const kind=resize.dataset.trackResize,track=Number(resize.dataset.track),next=e.key==='Home'?DEFAULT_TRACK_HEIGHT:trackHeight(kind,track)+(e.key==='ArrowUp'?8:-8);setTrackHeight(kind,track,next);markDirty();renderTimeline();grid.querySelector(`[data-track-resize="${kind}"][data-track="${track}"]`)?.focus();e.preventDefault();return;}const grip=e.target.closest?.('[data-track-move]');if(grip&&['ArrowUp','ArrowDown'].includes(e.key)){const kind=grip.dataset.trackMove,from=Number(grip.dataset.track),count=kind==='video'?project.videoTracks:project.audioTracks,to=clamp(from+(e.key==='ArrowUp'?-1:1),0,count-1);if(moveTimelineTrack(kind,from,to)){markDirty();renderAll();grid.querySelector(`[data-track-move="${kind}"][data-track="${to}"]`)?.focus();}e.preventDefault();return;}const marker=e.target.closest?.('[data-sequence-marker]');if(!marker||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;const kind=marker.dataset.sequenceMarker,current=kind==='in'?project.inPoint:project.outPoint,next=e.key==='Home'?0:e.key==='End'?duration():current+(e.key==='ArrowRight'?1:-1)/project.fps;setSequenceMarkerValue(kind,next);markDirty();renderTimeline();grid.querySelector(`[data-sequence-marker="${kind}"]`)?.focus();e.preventDefault();});
  grid.addEventListener('dblclick',e=>{const resize=e.target.closest?.('[data-track-resize]');if(!resize)return;setTrackHeight(resize.dataset.trackResize,Number(resize.dataset.track),DEFAULT_TRACK_HEIGHT);markDirty();renderTimeline();e.preventDefault();});
  grid.addEventListener('auxclick',e=>{if(e.button===1)e.preventDefault();});
  grid.addEventListener('click',e=>{
    const gap=e.target.closest('.an-gap');if(gap){const kind=gap.dataset.kind,track=Number(gap.dataset.track);if(isTrackLocked(kind,track)){notify(`${kind==='audio'?'A':'V'}${track+1} is locked`);return;}setTimelineSelection([]);selectedGap={key:gap.dataset.gap,kind,track,start:Number(gap.dataset.start),end:Number(gap.dataset.end)};renderTimeline();syncInspector();return;}
    if(e.target.closest('[data-time-display]')){toggleTimelineDisplay();return;}
    const target=e.target.closest('[data-target-track]');if(target){setActiveTimelineTrack(target.dataset.targetTrack,Number(target.dataset.track));return;}
    const visibility=e.target.closest('[data-toggle-track-visibility]');if(visibility){toggleVideoTrackVisibility(Number(visibility.dataset.toggleTrackVisibility));return;}
    const lock=e.target.closest('[data-toggle-track-lock]');if(lock){toggleTrackLock(lock.dataset.toggleTrackLock,Number(lock.dataset.track)||0);return;}
    const mute=e.target.closest('[data-toggle-audio-mute]');if(mute){toggleAudioTrackState(Number(mute.dataset.toggleAudioMute),'mute');return;}
    const solo=e.target.closest('[data-toggle-audio-solo]');if(solo){toggleAudioTrackState(Number(solo.dataset.toggleAudioSolo),'solo');return;}
    const remove=e.target.closest('[data-remove-track]');if(remove){removeTimelineTrack(remove.dataset.removeTrack,Number(remove.dataset.track));return;}
    const add=e.target.closest('[data-add-track]');if(!add)return;if(add.dataset.addTrack==='video'){project.videoTracks=clamp(project.videoTracks+1,1,MAX_VIDEO_TRACKS);activeVideoTrack=project.videoTracks-1;}else{project.audioTracks=clamp(project.audioTracks+1,0,MAX_AUDIO_TRACKS);activeAudioTrack=Math.max(0,project.audioTracks-1);}ensureTrackHeightCounts();markDirty();renderTimeline();
  });

  let dropLane=null;
  root.addEventListener('dragover',e=>{
    const files=[...(e.dataTransfer?.files||[])],items=[...(e.dataTransfer?.items||[])],supported=files.some(droppedFileKind)||items.some(item=>item.kind==='file'&&(/^(?:image|video|audio)\//.test(String(item.type||''))||!item.type));if(!supported)return;
    e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='copy';
    const direct=e.target.closest?.('.an-track-lane'),kinds=new Set(files.map(droppedFileKind).filter(Boolean)),compatible=direct&&(direct.dataset.kind==='audio'?kinds.has('audio')||!files.length:kinds.has('image')||kinds.has('video')||!files.length),lane=compatible?direct:null;
    if(lane&&isTrackLocked(lane.dataset.kind,Number(lane.dataset.track)||0)){e.dataTransfer.dropEffect='none';dropLane?.classList.remove('an-drop-target');dropLane=null;return;}
    if(dropLane!==lane){dropLane?.classList.remove('an-drop-target');dropLane=lane;dropLane?.classList.add('an-drop-target');}
  });
  root.addEventListener('dragleave',e=>{if(e.relatedTarget&&root.contains(e.relatedTarget))return;dropLane?.classList.remove('an-drop-target');dropLane=null;});
  root.addEventListener('drop',async e=>{
    const files=[...(e.dataTransfer?.files||[])],supported=files.filter(droppedFileKind);if(!supported.length)return;
    e.preventDefault();e.stopPropagation();const hitLane=e.target.closest?.('.an-track-lane'),videoLane=hitLane?.dataset.kind==='video'?hitLane:grid.querySelector(`.an-track-lane[data-kind="video"][data-track="${activeVideoTrack}"]`)||grid.querySelector('.an-track-lane[data-kind="video"][data-track="0"]'),audioLane=hitLane?.dataset.kind==='audio'?hitLane:grid.querySelector(`.an-track-lane[data-kind="audio"][data-track="${activeAudioTrack}"]`);
    const visualTrack=Number(videoLane?.dataset.track)||0,audioTrack=audioLane?Number(audioLane.dataset.track):Math.min(project.audioTracks,MAX_AUDIO_TRACKS-1),visualStart=videoLane&&hitLane===videoLane?pointerTime(e,videoLane):project.playhead,audioStart=audioLane&&hitLane===audioLane?pointerTime(e,audioLane):project.playhead,images=supported.filter(isImageFile),videos=supported.filter(isVideoFile),audios=supported.filter(isAudioFile);dropLane?.classList.remove('an-drop-target');dropLane=null;
    if(images.length){const imported=await onImportImages(images);if(imported?.length)addItems(imported,{append:false,track:visualTrack,start:visualStart});}
    if(videos.length)await addVideoFiles(videos,{track:visualTrack,start:visualStart+images.length*DEFAULT_SHOT_SECONDS});
    if(audios.length)await addAudioFiles(audios,{track:audioTrack,start:audioStart});
  });

  canvas.addEventListener('pointerdown',e=>{
    if(inlineTextDismissEvents.has(e)){e.preventDefault();return;}
    if(previewZoomLocked&&previewZoom>1&&!framingMode&&!drawMode&&(spaceHand||e.button===1)){
      if(spaceHand)spaceHand.used=true;revealPreviewZoomHud();e.preventDefault();return;
    }
    if(previewZoom>1&&!previewZoomLocked&&!framingMode&&!drawMode&&(spaceHand||e.button===1)){
      previewPanDrag={pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,panX:previewPanX,panY:previewPanY};
      if(spaceHand)spaceHand.used=true;canvas.parentElement.classList.add('preview-panning');canvas.style.cursor='grabbing';canvas.setPointerCapture(e.pointerId);revealPreviewZoomHud();e.preventDefault();return;
    }
    const clip=drawMode?drawingTargetClip():selectedClip();
    if(!drawMode&&!framingMode){
      const hit=hitTextControl(e);
      if(hit){
        if(isTrackLocked('text')){notify('T1 is locked');e.preventDefault();return;}
        if(inlineTextId)finishInlineTextEdit(false);setTimelineSelection([hit.text.id],hit.text.id);root.querySelector('[data-panel="text"]')?.click();
        const rect=canvas.getBoundingClientRect(),point=viewerPoint(e),startAngle=Math.atan2(point.y-hit.layout.cy,point.x-hit.layout.cx);
        textDrag={mode:hit.mode,textId:hit.text.id,startX:e.clientX,startY:e.clientY,x:hit.text.x,y:hit.text.y,width:rect.width,height:rect.height,startScale:hit.text.scale,startDistance:Math.max(1,Math.hypot(point.x-hit.layout.cx,point.y-hit.layout.cy)),startAngle,startRotation:hit.text.rotation};
        canvas.setPointerCapture(e.pointerId);syncInspector();drawViewer();e.preventDefault();return;
      }
    }
    if(activeTool==='text'&&!drawMode&&!framingMode){
      const rect=canvas.getBoundingClientRect();
      addTextAtTime(project.playhead,{x:(e.clientX-rect.left)/Math.max(1,rect.width),y:(e.clientY-rect.top)/Math.max(1,rect.height)});
      e.preventDefault();return;
    }
    if(framingMode&&clip&&!drawMode){
      const framing=clip.framing||(clip.framing={fit:'contain',scale:1,x:0,y:0});
      framingDrag={startX:e.clientX,startY:e.clientY,x:framing.x,y:framing.y};
      canvas.setPointerCapture(e.pointerId);e.preventDefault();return;
    }
    if(!drawMode&&!framingMode){setTimelineSelection([]);syncInspector();drawViewer();return;}
    if(!drawMode)return;const target=validateDrawingTarget();if(!target)return;const r=canvas.getBoundingClientRect(),x=clamp((e.clientX-r.left)/r.width,0,1),y=clamp((e.clientY-r.top)/r.height,0,1);drawPointer={x,y,inside:true};prepareActiveDrawing(target);activeStroke={tool:drawTool,brush:drawBrushType,color:drawColor,width:drawWidth,points:[{x,y}]};target.strokes.push(activeStroke);appendActiveDrawingSegment(activeStroke.points[0],activeStroke.points[0]);canvas.setPointerCapture(e.pointerId);scheduleActiveDrawingPaint();e.preventDefault();
  });
  canvas.addEventListener('pointermove',e=>{
    const pointerRect=canvas.getBoundingClientRect();drawPointer={x:clamp((e.clientX-pointerRect.left)/Math.max(1,pointerRect.width),0,1),y:clamp((e.clientY-pointerRect.top)/Math.max(1,pointerRect.height),0,1),inside:true};if(drawMode)positionDrawSizePreview();
    if(previewPanDrag){previewPanX=previewPanDrag.panX+e.clientX-previewPanDrag.startX;previewPanY=previewPanDrag.panY+e.clientY-previewPanDrag.startY;syncPreviewZoomUi({show:true});e.preventDefault();return;}
    if(textDrag){
      const text=project.texts.find(item=>item.id===textDrag.textId);if(!text)return;
      if(textDrag.mode==='move'){text.x=clamp(textDrag.x+(e.clientX-textDrag.startX)/textDrag.width,0,1);text.y=clamp(textDrag.y+(e.clientY-textDrag.startY)/textDrag.height,0,1);}
      else if(textDrag.mode==='scale'){const layout=textLayout(ctx,text,canvas.width,canvas.height),point=viewerPoint(e),distance=Math.hypot(point.x-layout.cx,point.y-layout.cy);text.scale=clamp(textDrag.startScale*distance/textDrag.startDistance,.25,4);}
      else if(textDrag.mode==='rotate'){const layout=textLayout(ctx,text,canvas.width,canvas.height),point=viewerPoint(e),angle=Math.atan2(point.y-layout.cy,point.x-layout.cx);let rotation=textDrag.startRotation+(angle-textDrag.startAngle)*180/Math.PI;while(rotation>180)rotation-=360;while(rotation<-180)rotation+=360;text.rotation=snappedTextRotation(rotation,e.shiftKey);}
      syncInspector();drawViewerLive();positionInlineTextEditor();return;
    }
    if(framingDrag){const c=selectedClip(),r=canvas.getBoundingClientRect();if(!c)return;c.framing.x=clamp(framingDrag.x+(e.clientX-framingDrag.startX)*2/r.width,-1,1);c.framing.y=clamp(framingDrag.y+(e.clientY-framingDrag.startY)*2/r.height,-1,1);scheduleFramingPreview();return;}
    if(activeStroke){const coalesced=typeof e.getCoalescedEvents==='function'?e.getCoalescedEvents():null,samples=coalesced?.length?coalesced:[e];for(const sample of samples){const point={x:clamp((sample.clientX-pointerRect.left)/Math.max(1,pointerRect.width),0,1),y:clamp((sample.clientY-pointerRect.top)/Math.max(1,pointerRect.height),0,1)},previous=activeStroke.points.at(-1),distance=Math.hypot((point.x-previous.x)*canvas.width,(point.y-previous.y)*canvas.height);if(distance<.35)continue;activeStroke.points.push(point);appendActiveDrawingSegment(previous,point);}scheduleActiveDrawingPaint();return;}
    if(!drawMode&&!framingMode){const hit=hitTextControl(e);canvas.style.cursor=hit?.mode==='scale'?'nwse-resize':hit?.mode==='rotate'?'grab':hit?'move':activeTool==='text'?'text':'default';}
  });
  canvas.addEventListener('pointerup',()=>{finishPreviewPan();if(textDrag){textDrag=null;markDirty();syncInspector();drawViewer();}if(framingDrag){framingDrag=null;flushFramingPreview({full:true});markDirty();syncInspector();}finishActiveDrawing();});
  canvas.addEventListener('pointercancel',()=>{finishPreviewPan();textDrag=null;if(framingDrag){framingDrag=null;flushFramingPreview({full:true});}finishActiveDrawing();});
  canvas.addEventListener('pointerenter',e=>{const r=canvas.getBoundingClientRect();drawPointer={x:clamp((e.clientX-r.left)/Math.max(1,r.width),0,1),y:clamp((e.clientY-r.top)/Math.max(1,r.height),0,1),inside:true};if(drawMode)showDrawSizePreview();});
  canvas.addEventListener('pointerleave',()=>{drawPointer.inside=false;hideDrawSizePreview();});
  canvas.addEventListener('dblclick',e=>{
    if(!drawMode&&!framingMode){
      const hit=hitTextControl(e);
      if(hit){
        e.preventDefault();
        if(hit.mode!=='move')return;
        if(isTrackLocked('text')){notify('T1 is locked');return;}
        setTimelineSelection([hit.text.id],hit.text.id);root.querySelector('[data-panel="text"]')?.click();syncInspector();drawViewer();beginInlineTextEdit(hit.text);return;
      }
    }
    const clip=clipsAt(project.playhead).at(-1)||selectedClip();
    if(clip&&isTrackLocked('video',Number(clip.track)||0)){notify(`V${(Number(clip.track)||0)+1} is locked`);return;}
    if(clip)setTimelineSelection([clip.id],clip.id);
    if(!clip){notify('Move the playhead over a shot first');return;}
    framingMode=!framingMode;drawMode=false;canvas.style.cursor=framingMode?'move':'default';
    root.querySelector('[data-panel="clip"]')?.click();syncInspector();drawViewer();
  });
  viewerViewport.addEventListener('wheel',e=>{
    const overPreview=canvas.parentElement.contains(e.target);
    if(framingMode&&selectedClip()&&overPreview){e.preventDefault();const framing=selectedClip().framing;framing.scale=clamp(framing.scale*Math.exp(-e.deltaY*.001),.01,8);deferMarkDirty();syncInspector();scheduleFramingPreview();scheduleFramingPreviewFinish();return;}
    if(activeStroke)return;
    e.preventDefault();
    if(previewZoomLocked){revealPreviewZoomHud();return;}
    const rect=canvas.parentElement.getBoundingClientRect(),clientX=clamp(e.clientX,rect.left,rect.right),clientY=clamp(e.clientY,rect.top,rect.bottom);
    setPreviewZoom(previewZoom*Math.exp(-e.deltaY*.0012),{clientX,clientY,show:true});
  },{passive:false});
  inlineTextEditor.addEventListener('input',()=>{const text=project.texts.find(item=>item.id===inlineTextId);if(!text||isTrackLocked('text'))return;text.content=inlineTextEditor.value;$('#anText').value=text.content;positionInlineTextEditor();});
  inlineTextEditor.addEventListener('blur',()=>finishInlineTextEdit(false));
  inlineTextEditor.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape'){finishInlineTextEdit(true);canvas.focus();e.preventDefault();}else if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){finishInlineTextEdit(false);canvas.focus();e.preventDefault();}});
  document.addEventListener('pointerdown',e=>{
    if(e.button!==0||!inlineTextId||inlineTextEditor.contains(e.target))return;
    if(e.target===canvas){
      const hit=hitTextControl(e);finishInlineTextEdit(false);
      if(!hit){inlineTextDismissEvents.add(e);setTimelineSelection([]);syncInspector();drawViewer();}
      return;
    }
    finishInlineTextEdit(false);
  },true);

  $('#anBack').onclick=closeEditor;
  $('#anGuides').onclick=()=>setSafeGuidesVisible(!safeGuidesVisible);
  $('#anPreviewMute').onclick=()=>setPreviewMuted(!previewMuted);
  $('#anPlay').onclick=()=>setPlaying(!playing);
  $('#anPrev').onclick=()=>setPlayhead(project.playhead-1/project.fps);
  $('#anNext').onclick=()=>setPlayhead(project.playhead+1/project.fps);
  $('#anInspector').onclick=()=>{setDrawWidthMenuOpen(false);root.classList.toggle('panel-open');requestAnimationFrame(resizeViewer);};
  $('#anZoom').oninput=e=>applyTimelineZoom(e.target.value);$('#anZoom').onchange=()=>deferMarkDirty(0);
  $('#anSequenceSettings').onclick=openSequenceSettings;$('#anSequenceMode').onchange=()=>syncSequenceModeUi({populate:true});$('#anSequenceDuration').oninput=()=>{if($('#anSequenceDuration').value.trim()){$('#anSequenceMode').value='fixed';syncSequenceModeUi();}};$('#anSequenceCancel').onclick=()=>$('#anSequenceModal').classList.remove('open');$('#anSequenceApply').onclick=applySequenceSettings;
  $('#anSetIn').onclick=setSequenceIn;$('#anSetOut').onclick=setSequenceOut;$('#anClearRange').onclick=clearSequenceRange;
  const inspectorResizer=$('#anInspectorResizer');
  inspectorResizer.addEventListener('pointerdown',e=>{if(!root.classList.contains('panel-open'))return;inspectorResize={startX:e.clientX,startWidth:project.inspectorWidth};root.classList.add('inspector-resizing');inspectorResizer.classList.add('dragging');inspectorResizer.setPointerCapture?.(e.pointerId);e.preventDefault();});
  inspectorResizer.addEventListener('pointermove',e=>{if(!inspectorResize)return;project.inspectorWidth=clamp(inspectorResize.startWidth+e.clientX-inspectorResize.startX,MIN_INSPECTOR_WIDTH,inspectorWidthMaximum());applyInspectorWidth();resizeViewer();});
  inspectorResizer.addEventListener('pointerup',()=>{if(!inspectorResize)return;inspectorResize=null;root.classList.remove('inspector-resizing');inspectorResizer.classList.remove('dragging');markDirty();});
  inspectorResizer.addEventListener('pointercancel',()=>{if(inspectorResize)project.inspectorWidth=inspectorResize.startWidth;inspectorResize=null;root.classList.remove('inspector-resizing');inspectorResizer.classList.remove('dragging');applyInspectorWidth();resizeViewer();});
  inspectorResizer.addEventListener('dblclick',()=>{project.inspectorWidth=DEFAULT_INSPECTOR_WIDTH;applyInspectorWidth();resizeViewer();markDirty();});
  inspectorResizer.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home'].includes(e.key))return;project.inspectorWidth=e.key==='Home'?DEFAULT_INSPECTOR_WIDTH:clamp(project.inspectorWidth+(e.key==='ArrowRight'?24:-24),MIN_INSPECTOR_WIDTH,inspectorWidthMaximum());applyInspectorWidth();resizeViewer();markDirty();e.preventDefault();});
  const timelineResizer=$('#anTimelineResizer');
  timelineResizer.addEventListener('pointerdown',e=>{timelineResize={startY:e.clientY,startHeight:project.timelineHeight,nextHeight:project.timelineHeight};timelineResizer.classList.add('dragging');timelineResizer.setPointerCapture?.(e.pointerId);e.preventDefault();});
  timelineResizer.addEventListener('pointermove',e=>{if(!timelineResize)return;scheduleTimelineResize(clamp(timelineResize.startHeight+timelineResize.startY-e.clientY,180,Math.max(180,window.innerHeight-220)));});
  timelineResizer.addEventListener('pointerup',()=>{if(!timelineResize)return;paintTimelineResize({redraw:true});timelineResize=null;timelineResizer.classList.remove('dragging');markDirty();});
  timelineResizer.addEventListener('pointercancel',()=>{if(!timelineResize)return;paintTimelineResize({redraw:true});timelineResize=null;timelineResizer.classList.remove('dragging');});
  timelineResizer.addEventListener('dblclick',()=>{project.timelineHeight=286;applyTimelineHeight();resizeViewer();markDirty();});
  timelineResizer.addEventListener('keydown',e=>{if(!['ArrowUp','ArrowDown','Home'].includes(e.key))return;project.timelineHeight=e.key==='Home'?286:clamp(project.timelineHeight+(e.key==='ArrowUp'?24:-24),180,Math.max(180,window.innerHeight-220));applyTimelineHeight();resizeViewer();markDirty();e.preventDefault();});
  scroll.addEventListener('scroll',syncPlayheadVisibility,{passive:true});
  scroll.addEventListener('wheel',e=>{
    if(!e.altKey)return;
    e.preventDefault();
    const slider=$('#anZoom'),oldPx=Number(slider.value)||90;
    const next=clamp(oldPx*Math.exp(-e.deltaY*.0025),Number(slider.min),Number(slider.max));
    applyTimelineZoom(next);deferMarkDirty();
  },{passive:false});
  const applyLiveDurationInput=(input,frames=false)=>{if(input.value==='')return;const numeric=Number(input.value);if(!Number.isFinite(numeric))return;const duration=frames?clamp(Math.round(numeric||1),1,36000)/project.fps:Math.max(1,Math.round(numeric*project.fps))/project.fps;applySelectedDuration(duration,{commit:false});};
  for(const id of ['anDuration','anAudioDuration']){const input=$('#'+id);input.oninput=()=>applyLiveDurationInput(input);input.onchange=()=>{if(input.value==='')syncInspector();flushDeferredHistory();};}
  for(const id of ['anDurationFrames','anAudioDurationFrames']){const input=$('#'+id);input.oninput=()=>applyLiveDurationInput(input,true);input.onchange=()=>{if(input.value==='')syncInspector();flushDeferredHistory();};}
  const applyFraming=fit=>{const clips=selectedVisualClips();if(!clips.length)return;for(const clip of clips)clip.framing={fit,scale:1,x:0,y:0};markDirty();syncInspector();drawViewer();};
  $('#anFrameFit').onclick=()=>applyFraming('contain');
  $('#anFrameFill').onclick=()=>applyFraming('cover');
  $('#anFrameReset').onclick=()=>applyFraming('contain');
  $('#anToggleClipVisibility').onclick=toggleSelectedVisualVisibility;
  $('#anFrameScale').oninput=e=>{const clips=selectedVisualClips();if(!clips.length)return;clearTimeout(framingPreviewFinishTimer);framingPreviewFinishTimer=0;const effective=clamp(Number(e.target.value)/100,.25,8);for(const clip of clips)setClipEffectiveFramingScale(clip,effective);const label=`${Math.round(effective*100)}%`;$('#anFrameScaleVal').value=label;$('#anFrameScaleVal').textContent=label;scheduleFramingPreview();deferMarkDirty();};
  $('#anFrameScale').onchange=()=>{clearTimeout(framingPreviewFinishTimer);framingPreviewFinishTimer=0;flushFramingPreview({full:true});flushDeferredHistory();};
  $('#anDeleteClip').onclick=deleteSelected;
  $('#anSplit').onclick=splitSelected;
  $('#anAudioSplit').onclick=splitSelected;
  $('#anAudioDelete').onclick=deleteSelected;
  $('#anAudioVolume').oninput=e=>{const clips=selectedAudioClips();if(!clips.length)return;const volume=clamp(Number(e.target.value)/100,0,MAX_AUDIO_GAIN);for(const audio of clips){audio.volume=volume;updateActiveAudioGain(audio);}const label=`${Math.round(volume*100)}%`;$('#anAudioVolumeVal').value=label;$('#anAudioVolumeVal').textContent=label;$('#anAudioMute').classList.toggle('on',volume===0);$('#anAudioMute').textContent=volume===0?'Unmute selected':'Mute selected';deferMarkDirty();};
  $('#anAudioVolume').onchange=flushDeferredHistory;
  $('#anAudioMute').onclick=()=>{const clips=selectedAudioClips();if(!clips.length)return;const mute=clips.some(audio=>audio.volume>0);for(const audio of clips){if(mute){if(audio.volume>0)audio.lastVolume=audio.volume;audio.volume=0;}else audio.volume=clamp(Number(audio.lastVolume)||1,0,MAX_AUDIO_GAIN);updateActiveAudioGain(audio);}markDirty();syncInspector();};
  $('#anAudioGain').onclick=openAudioGainDialog;$('#anGainCancel').onclick=closeAudioGainDialog;$('#anGainApply').onclick=applyAudioGainDialog;$('#anGainDb').addEventListener('keydown',e=>{if(e.key==='Enter'){applyAudioGainDialog();e.preventDefault();}});
  for(const side of ['In','Out']){const durationInput=$(`#anFade${side}Duration`),curveInput=$(`#anFade${side}Curve`),shapeInput=$(`#anFade${side}Shape`),applyDuration=()=>{if(durationInput.value==='')return;const frames=Math.max(0,Math.round((Number(durationInput.value)||0)*project.fps));applySelectedFadeSetting(side,'Duration',frames/project.fps,{commit:false});deferMarkDirty();};durationInput.oninput=applyDuration;durationInput.onchange=()=>{if(durationInput.value==='')syncInspector();flushDeferredHistory();};curveInput.onchange=()=>applySelectedFadeSetting(side,'Curve',curveInput.value);shapeInput.oninput=()=>{applySelectedFadeSetting(side,'Shape',Number(shapeInput.value)||0,{commit:false});deferMarkDirty();};shapeInput.onchange=flushDeferredHistory;}
  $('#anLink').onclick=toggleLinkSelection;
  $('#anAddText').onclick=upsertTextLayer;
  $('#anClearText').onclick=()=>{if(selectedText())deleteSelected();};
  for(const id of ['anTextSize','anTextColor','anTextScale','anTextRotation','anTextDuration'])$('#'+id).addEventListener('input',()=>{updateSelectedTextFromControls();if(selectedText())deferMarkDirty();});
  $('#anTextDuration').addEventListener('input',()=>{if(selectedText())renderTimeline();});
  $('#anText').addEventListener('input',()=>{const text=selectedText();if(text){text.content=$('#anText').value;if(text.id===inlineTextId){inlineTextEditor.value=text.content;positionInlineTextEditor();}else drawViewerLive();deferMarkDirty();}});
  $('#anText').addEventListener('change',()=>{if(selectedText()){flushDeferredHistory();renderTimeline();drawViewer();}});
  for(const id of ['anTextSize','anTextColor','anTextScale','anTextRotation','anTextDuration'])$('#'+id).addEventListener('change',()=>{if(selectedText()){flushDeferredHistory();drawViewer();}});
  const commitTextStyleControls=()=>{if(!selectedText())return;updateSelectedTextFromControls();markDirty();syncInspector();drawViewer();};
  $('#anTextFont').addEventListener('change',commitTextStyleControls);
  for(const id of ['anTextBold','anTextItalic','anTextBackground'])$('#'+id).onclick=e=>{e.currentTarget.classList.toggle('on');commitTextStyleControls();};
  root.querySelectorAll('[data-an-text-align]').forEach(button=>button.onclick=()=>{root.querySelectorAll('[data-an-text-align]').forEach(candidate=>candidate.classList.toggle('on',candidate===button));commitTextStyleControls();});
  $('#anTextColorButton').onclick=()=>setTextColorOpen(!textColorOpen);
  for(const color of DRAW_COLOR_PRESETS){const button=document.createElement('button');button.type='button';button.className='an-draw-cp-preset';button.dataset.anTextColor=color;button.style.background=color;button.title=color;button.onclick=()=>applyTextColor(color,{emit:true,commit:true});$('#anTextCpPresets').append(button);}
  let textColorPointer=null;const textSv=$('#anTextCpSv'),updateTextSv=e=>{const rect=textSv.getBoundingClientRect();textColorS=clamp((e.clientX-rect.left)/Math.max(1,rect.width),0,1);textColorV=1-clamp((e.clientY-rect.top)/Math.max(1,rect.height),0,1);applyTextColorHsv();};
  textSv.addEventListener('pointerdown',e=>{textColorPointer=e.pointerId;textSv.setPointerCapture?.(e.pointerId);updateTextSv(e);e.preventDefault();});textSv.addEventListener('pointermove',e=>{if(textColorPointer===e.pointerId)updateTextSv(e);});textSv.addEventListener('pointerup',e=>{if(textColorPointer===e.pointerId){textColorPointer=null;dispatchTextColor(true);}});textSv.addEventListener('pointercancel',()=>{textColorPointer=null;});
  $('#anTextCpHue').oninput=e=>{textColorH=clamp(Number(e.target.value)||0,0,360);applyTextColorHsv();};$('#anTextCpHue').onchange=()=>dispatchTextColor(true);
  $('#anTextCpHex').oninput=e=>{if(parseDrawHex(e.target.value))applyTextColor(e.target.value,{emit:true});};$('#anTextCpHex').onchange=e=>{if(!applyTextColor(e.target.value,{emit:true,commit:true}))e.target.value=$('#anTextColor').value;};$('#anTextCpHex').onkeydown=e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();e.target.blur();}};
  $('#anDrawToggle').onclick=()=>setDrawMode(!drawMode);
  $('#anDrawPen').onclick=()=>{setDrawTool('pen');setDrawBrushesOpen(!drawBrushesOpen);};
  $('#anDrawEraser').onclick=()=>setDrawTool('eraser');
  root.querySelectorAll('[data-an-brush]').forEach(button=>button.onclick=()=>{setDrawBrush(button.dataset.anBrush);setDrawBrushesOpen(false);});
  $('#anDrawColorButton').onclick=()=>setDrawColorOpen(!drawColorOpen);
  $('#anDrawWidthDown').onclick=()=>adjustDrawWidth(-1,{preview:true});$('#anDrawWidthUp').onclick=()=>adjustDrawWidth(1,{preview:true});
  const drawWidthInput=$('#anDrawWidthVal'),commitDrawWidthInput=()=>{if(String(drawWidthInput.value).trim())setDrawWidth(drawWidthInput.value,{preview:true});drawWidthInput.value=String(drawWidth);};drawWidthInput.addEventListener('input',()=>{if(String(drawWidthInput.value).trim())setDrawWidth(drawWidthInput.value,{preview:true});});drawWidthInput.addEventListener('change',commitDrawWidthInput);drawWidthInput.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();commitDrawWidthInput();drawWidthInput.blur();}else if(e.key==='Escape'){drawWidthInput.value=String(drawWidth);drawWidthInput.blur();}});$('#anDrawWidthMenuButton').onclick=()=>setDrawWidthMenuOpen(!drawWidthMenuOpen);
  for(const width of DRAW_WIDTH_PRESETS){const button=document.createElement('button');button.type='button';button.className='an-draw-size-option';button.dataset.anDrawWidth=String(width);button.setAttribute('role','option');button.textContent=String(width);button.onclick=()=>{setDrawWidth(width,{preview:true});setDrawWidthMenuOpen(false);};$('#anDrawWidthMenu').append(button);}
  root.append($('#anDrawWidthMenu'));
  $('#anClearDraw').onclick=()=>{const clip=validateDrawingTarget();if(!clip)return;clip.strokes=[];drawingOverlayCache.clear();markDirty();syncDrawUi();drawViewer();renderTimeline();};
  for(const color of DRAW_COLOR_PRESETS){const button=document.createElement('button');button.type='button';button.className='an-draw-cp-preset';button.dataset.anDrawColor=color;button.style.background=color;button.title=color;button.onclick=()=>applyDrawColor(color);$('#anDrawCpPresets').append(button);}
  let drawColorPointer=null;const drawSv=$('#anDrawCpSv'),updateDrawSv=e=>{const rect=drawSv.getBoundingClientRect();drawColorS=clamp((e.clientX-rect.left)/Math.max(1,rect.width),0,1);drawColorV=1-clamp((e.clientY-rect.top)/Math.max(1,rect.height),0,1);syncDrawColorUi();syncDrawUi();};
  drawSv.addEventListener('pointerdown',e=>{drawColorPointer=e.pointerId;drawSv.setPointerCapture?.(e.pointerId);updateDrawSv(e);e.preventDefault();});drawSv.addEventListener('pointermove',e=>{if(drawColorPointer===e.pointerId)updateDrawSv(e);});drawSv.addEventListener('pointerup',e=>{if(drawColorPointer===e.pointerId)drawColorPointer=null;});drawSv.addEventListener('pointercancel',()=>{drawColorPointer=null;});
  $('#anDrawCpHue').oninput=e=>{drawColorH=clamp(Number(e.target.value)||0,0,360);syncDrawColorUi();syncDrawUi();};
  $('#anDrawCpHex').oninput=e=>{if(parseDrawHex(e.target.value))applyDrawColor(e.target.value);};$('#anDrawCpHex').onchange=e=>{if(!applyDrawColor(e.target.value))e.target.value=drawColor;};$('#anDrawCpHex').onkeydown=e=>{e.stopPropagation();if(e.key==='Enter'){e.preventDefault();e.target.blur();}};
  root.addEventListener('pointerdown',e=>{if(drawWidthMenuOpen&&!e.target.closest('.an-draw-size-combo,#anDrawWidthMenu'))setDrawWidthMenuOpen(false);},true);
  root.addEventListener('pointerdown',e=>{if(textColorOpen&&!e.target.closest('#anTextColorButton,#anTextColorPop'))setTextColorOpen(false);},true);
  root.addEventListener('scroll',()=>{if(drawWidthMenuOpen)positionDrawWidthMenu();},true);
  applyDrawColor(drawColor);
  applyTextColor($('#anTextColor').value);
  $('#anTcToggle').onclick=()=>{project.timecode=!project.timecode;markDirty();syncInspector();drawViewer();};
  $('#anCounterMode').onchange=e=>{project.counterMode=e.target.value;markDirty();renderAll();};
  $('#anProjectFps').onchange=e=>{project.fps=Number(e.target.value);markDirty();renderAll();updateAudioTrimUi();};
  $('#anFooterQuality').onchange=e=>{project.previewQuality=e.target.value;markDirty();applyPreviewQuality();resizeViewer();syncInspector();};
  $('#anFooterAspect').onchange=e=>{project.aspect=ASPECT_RATIOS[e.target.value]?e.target.value:'16:9';markDirty();applyPreviewQuality();resizeViewer();syncInspector();};
  $('#anPreviewFit').onclick=()=>fitPreviewZoom({show:true});
  $('#anPreviewLock').onclick=()=>setPreviewZoomLocked(!previewZoomLocked);
  $('#anBackground').onchange=e=>{project.background=e.target.value;markDirty();drawViewer();};
  $('#anAddImages').onclick=()=>options.onRequestImages?.();
  $('#anAddVideo').onclick=()=>$('#anVideoPick').click();
  $('#anAddAudio').onclick=()=>$('#anAudioPick').click();
  $('#anVideoPick').onchange=e=>{addVideoFiles(e.target.files,{track:activeVideoTrack,start:project.playhead});e.target.value='';};
  $('#anAudioPick').onchange=e=>{addAudioFiles(e.target.files);e.target.value='';};
  $('#anTrimInFrames').oninput=e=>{if(!audioTrimState)return;audioTrimState.in=Number(e.target.value)/project.fps;updateAudioTrimUi();};
  $('#anTrimOutFrames').oninput=e=>{if(!audioTrimState)return;audioTrimState.out=Number(e.target.value)/project.fps;updateAudioTrimUi();};
  $('#anTrimSetIn').onclick=()=>{if(!audioTrimState)return;audioTrimState.in=$('#anTrimPlayer').currentTime;updateAudioTrimUi();};
  $('#anTrimSetOut').onclick=()=>{if(!audioTrimState)return;audioTrimState.out=$('#anTrimPlayer').currentTime;updateAudioTrimUi();};
  $('#anTrimPlaySelection').onclick=()=>{if(!audioTrimState)return;const player=$('#anTrimPlayer');audioTrimState.playingSelection=true;player.currentTime=audioTrimState.in;player.play().catch(()=>{});drawAudioTrimWave();};
  $('#anTrimCancel').onclick=()=>finishAudioTrimmer(false);
  $('#anTrimUse').onclick=()=>finishAudioTrimmer(true);
  $('#anTrimPlayer').ontimeupdate=()=>{if(!audioTrimState)return;const player=$('#anTrimPlayer');if(audioTrimState.playingSelection&&player.currentTime>=audioTrimState.out-.005){player.pause();player.currentTime=audioTrimState.out;audioTrimState.playingSelection=false;}drawAudioTrimWave();};
  $('#anTrimPlayer').onpause=()=>{if(audioTrimState){audioTrimState.playingSelection=false;drawAudioTrimWave();}};
  const setTrimFromPointer=e=>{
    if(!audioTrimState)return;
    const shell=$('#anTrimWaveShell'),rect=shell.getBoundingClientRect();
    const time=clamp((e.clientX-rect.left)/rect.width,0,1)*audioTrimState.duration;
    if(!trimHandleDrag)trimHandleDrag=Math.abs(time-audioTrimState.in)<=Math.abs(time-audioTrimState.out)?'in':'out';
    if(trimHandleDrag==='in')audioTrimState.in=time;else audioTrimState.out=time;
    $('#anTrimPlayer').currentTime=time;updateAudioTrimUi();
  };
  $('#anTrimWaveShell').addEventListener('pointerdown',e=>{if(!audioTrimState)return;trimHandleDrag=null;setTrimFromPointer(e);e.currentTarget.setPointerCapture?.(e.pointerId);e.preventDefault();});
  $('#anTrimWaveShell').addEventListener('pointermove',e=>{if(trimHandleDrag)setTrimFromPointer(e);});
  $('#anTrimWaveShell').addEventListener('pointerup',()=>{trimHandleDrag=null;});
  $('#anTrimWaveShell').addEventListener('pointercancel',()=>{trimHandleDrag=null;});
  root.querySelectorAll('.an-tab').forEach(tab=>tab.onclick=()=>{setDrawWidthMenuOpen(false);root.querySelectorAll('.an-tab,.an-panel').forEach(el=>el.classList.remove('on'));tab.classList.add('on');root.querySelector(`[data-panel-body="${tab.dataset.panel}"]`).classList.add('on');syncInspector();});
  root.querySelectorAll('[data-an-tool]').forEach(button=>button.onclick=()=>setActiveTool(button.dataset.anTool));
  $('#anSnap').onclick=()=>{project.timelineSnap=!project.timelineSnap;markDirty();renderTimeline();notify(project.timelineSnap?'Timeline snapping on':'Timeline snapping off');};
  function syncExportFormatUi(){
    const format=$('#anExportFormat').value,premiere=format==='premiere',afterEffects=format==='after-effects';
    $('#anExportDescription').textContent=premiere?`Premiere timeline · collected original media · ${project.aspect}`:afterEffects?`After Effects editable project · collected original media · ${project.aspect}`:`MP4 · H.264 · stereo audio · ${project.aspect}`;
    $('#anExportCounterField').style.display=format==='mp4'?'':'none';
    $('#anExportGo').textContent=premiere?'Export Premiere XML':afterEffects?'Export After Effects':'Export MP4';
  }
  $('#anExport').onclick=()=>{const rangeOption=$('#anExportRange').querySelector('[value="inout"]');rangeOption.disabled=!hasSequenceRange();if(!hasSequenceRange())$('#anExportRange').value='full';$('#anExportRes').value=project.resolution;$('#anExportFps').value=project.fps;syncExportFormatUi();$('#anExportModal').classList.add('open');};
  $('#anExportCancel').onclick=()=>$('#anExportModal').classList.remove('open');
  $('#anExportFormat').onchange=syncExportFormatUi;
  $('#anExportGo').onclick=()=>{const format=$('#anExportFormat').value;if(format==='premiere')exportPremiereProject();else if(format==='after-effects')exportAfterEffectsProject();else exportProject();};

  window.addEventListener('resize',()=>{if(open){applyInspectorWidth();resizeViewer();renderTimeline();positionDrawWidthMenu();}});
  function inspectorSpacePlaybackAllowed(target){if(inlineTextId||root.querySelector('.an-export-modal.open,.an-audio-trim-modal.open'))return false;if(target?.isContentEditable||target?.matches?.('textarea,[contenteditable="true"]'))return false;return true;}
  function flushInspectorEditsForPlayback(target){if(target?.closest?.('.an-side')&&target.matches?.('input,select'))target.dispatchEvent(new Event('change',{bubbles:true}));flushDeferredHistory();}
  window.addEventListener('keydown',e=>{
    if(!open)return;
    const form=e.target.matches('input,textarea,select'),key=e.key.toLowerCase(),mod=e.ctrlKey||e.metaKey;
    if(mod&&(key==='z'||key==='y')){if(form&&!inlineTextId)e.target.blur();const wantsRedo=key==='y'||e.shiftKey;wantsRedo?redoAnimatics():undoAnimatics();e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&mod&&key==='c'){copyTimelineSelection(false);e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&mod&&key==='x'){copyTimelineSelection(true);e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&mod&&key==='v'){pasteTimelineSelection();e.preventDefault();e.stopImmediatePropagation();}
    else if(e.key==='Escape'){if(root.querySelector('.an-view-select.open'))closeAnimaticsSelectMenus();else if(textColorOpen)setTextColorOpen(false);else if(e.target===drawWidthInput){drawWidthInput.value=String(drawWidth);drawWidthInput.blur();}else if(inlineTextId)finishInlineTextEdit(true);else if($('#anGainModal').classList.contains('open'))closeAudioGainDialog();else if($('#anAudioTrimModal').classList.contains('open'))finishAudioTrimmer(false);else if($('#anSequenceModal').classList.contains('open'))$('#anSequenceModal').classList.remove('open');else if($('#anExportModal').classList.contains('open'))$('#anExportModal').classList.remove('open');else if(drawWidthMenuOpen)setDrawWidthMenuOpen(false);else if(drawColorOpen)setDrawColorOpen(false);else if(drawBrushesOpen)setDrawBrushesOpen(false);else if(drawMode)setDrawMode(false);else if(selectedGap){selectedGap=null;renderTimeline();}else if(activeTool!=='select')setActiveTool('select');else closeEditor();e.preventDefault();e.stopImmediatePropagation();}
    else if(e.code==='Space'&&inspectorSpacePlaybackAllowed(e.target)){if(!spaceHand){flushInspectorEditsForPlayback(e.target);spaceHand={startedAt:Date.now(),used:false};setActiveTool('hand');if(previewZoom>1&&!previewZoomLocked&&!framingMode&&!drawMode)canvas.style.cursor='grab';}e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&mod&&key==='a'){setTimelineSelection([...project.clips,...project.texts,...project.audio].map(item=>item.id),primarySelectionId());renderTimeline();syncInspector();e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&mod&&key==='l'){toggleLinkSelection();e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&mod&&key==='h'){toggleSelectedVisualVisibility();e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&!mod&&key==='d'){if(setDrawMode(!drawMode)&&drawMode)root.querySelector('[data-panel="draw"]')?.click();e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&!mod&&drawMode&&key==='e'){setDrawTool('eraser');notify('Eraser');e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&!mod&&drawMode&&(e.key==='['||e.key===']')){adjustDrawWidth(e.key==='['?-1:1,{preview:true});e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&!mod&&key==='g'){openAudioGainDialog();e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&!mod&&['v','t','c','h'].includes(key)){setActiveTool(key==='v'?'select':key==='t'?'text':key==='c'?'razor':'hand');e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&!mod&&key==='s'){project.timelineSnap=!project.timelineSnap;markDirty();renderTimeline();e.preventDefault();e.stopImmediatePropagation();}
    else if(key==='i'&&!form){setSequenceIn();e.preventDefault();e.stopImmediatePropagation();}
    else if(key==='o'&&!form){setSequenceOut();e.preventDefault();e.stopImmediatePropagation();}
    else if((e.key==='Delete'||e.key==='Backspace')&&!e.target.matches('input,textarea')){deleteSelected();e.preventDefault();e.stopImmediatePropagation();}
  },true);
  window.addEventListener('keyup',e=>{if(!open||e.code!=='Space'||!spaceHand)return;const state=spaceHand;spaceHand=null;if(handPan){grid.releasePointerCapture?.(handPan.pointerId);handPan=null;root.classList.remove('hand-panning');state.used=true;}if(previewPanDrag){canvas.releasePointerCapture?.(previewPanDrag.pointerId);finishPreviewPan();state.used=true;}setActiveTool('select');if(!state.used&&Date.now()-state.startedAt<260)setPlaying(!playing);e.preventDefault();e.stopImmediatePropagation();},true);

  async function exportProject(){
    if(!project.clips.length){notify('Add at least one clip');return;}
    if(!window.RefBoardAPI?.beginAnimaticExport){notify('MP4 export is available in the desktop build');return;}
    const fps=Number($('#anExportFps').value),res=Number($('#anExportRes').value),{width:w,height:h}=sequenceDimensions(res,project.aspect),burn=$('#anExportTc').value==='on'||($('#anExportTc').value==='project'&&project.timecode);
    const useRange=$('#anExportRange').value==='inout'&&hasSequenceRange(),exportStart=useRange?project.inPoint:0,exportEnd=useRange?Math.min(duration(),project.outPoint):duration();
    if(exportEnd<=exportStart+MIN_SHOT_SECONDS){notify('The selected export range is empty');return;}
    project.fps=fps;project.resolution=res; const progress=$('#anExportProgress'),bar=progress.querySelector('i'),go=$('#anExportGo');progress.classList.add('show');go.disabled=true;
    let token=null;
    try{
      const begun=await window.RefBoardAPI.beginAnimaticExport({defaultName:`refboard-animatic-${new Date().toISOString().replace(/[:.]/g,'-')}.mp4`,fps,width:w,height:h});
      if(!begun?.started)return; token=begun.token;
      const hasVideo=project.clips.some(c=>isVideoClip(c)&&isVisualClipVisible(c)&&c.start<exportEnd&&c.start+c.duration>exportStart),segments=[];
      if(hasVideo){const frameDuration=1/fps;for(let start=exportStart;start<exportEnd-1e-8;start+=frameDuration)segments.push({start,duration:Math.min(frameDuration,exportEnd-start)});}
      else{const boundaries=[...new Set([exportStart,exportEnd,...project.clips.flatMap(c=>[c.start,c.start+c.duration]),...project.texts.flatMap(c=>[c.start,c.start+c.duration]),...project.audio.flatMap(c=>[c.start,c.start+c.duration])])].filter(t=>t>=exportStart&&t<=exportEnd).sort((a,b)=>a-b);for(let i=0;i<boundaries.length-1;i++){const start=boundaries[i],end=boundaries[i+1];if(end>start)segments.push({start,duration:end-start});}}
      const exportAudio=project.audio.map(a=>{const clipStart=Math.max(a.start,exportStart),clipEnd=Math.min(a.start+a.duration,exportEnd);if(clipEnd<=clipStart)return null;const localStart=clipStart-a.start,clipDuration=clipEnd-clipStart;return {...a,start:clipStart-exportStart,sourceIn:(a.sourceIn||0)+localStart,duration:clipDuration,volume:effectiveAudioVolume(a),envelope:audioEnvelopePoints(a,{start:localStart,end:localStart+clipDuration,samplesPerFade:32}).map(point=>({time:point.time-localStart,gain:point.gain}))};}).filter(Boolean);
      for(let i=0;i<segments.length;i++){
        const c=document.createElement('canvas');c.width=w;c.height=h;await drawViewer(c.getContext('2d'),w,h,segments[i].start,burn,true);const blob=await new Promise(r=>c.toBlob(r,'image/png'));c.width=c.height=0;
        await window.RefBoardAPI.appendAnimaticFrame(token,{duration:segments[i].duration,data:await blob.arrayBuffer()});bar.style.width=`${Math.round((i+1)/(segments.length+exportAudio.length)*85)}%`;
      }
      for(let i=0;i<exportAudio.length;i++){const a=exportAudio[i];if(!a.blob)continue;await window.RefBoardAPI.appendAnimaticAudio(token,{name:a.name,start:a.start,sourceIn:a.sourceIn||0,duration:a.duration,volume:a.volume,envelope:a.envelope,data:await a.blob.arrayBuffer()});}
      bar.style.width='90%';const result=await window.RefBoardAPI.finishAnimaticExport(token);token=null;bar.style.width='100%';$('#anExportModal').classList.remove('open');notify(result?.saved?'Animatic exported':'Export canceled');
    }catch(err){console.error('[animatics] export failed',err);if(token)await window.RefBoardAPI.abortAnimaticExport?.(token).catch(()=>{});notify('Export failed — check available disk space');}
    finally{go.disabled=false;setTimeout(()=>{progress.classList.remove('show');bar.style.width='0';},500);}
  }

  function premiereAssetExtension(name,blob,kind){
    const supplied=(String(name||'').match(/\.[A-Za-z0-9]{1,8}$/)||[])[0];if(supplied)return supplied.toLowerCase();
    const byType={'image/png':'.png','image/jpeg':'.jpg','image/gif':'.gif','image/webp':'.webp','image/bmp':'.bmp','image/tiff':'.tif','video/mp4':'.mp4','video/quicktime':'.mov','video/webm':'.webm','audio/wav':'.wav','audio/x-wav':'.wav','audio/mpeg':'.mp3','audio/mp4':'.m4a','audio/aac':'.aac','audio/ogg':'.ogg','audio/flac':'.flac'};
    return byType[String(blob?.type||'').toLowerCase()]||(kind==='audio'?'.wav':kind==='video'?'.mp4':'.png');
  }

  async function premiereOverlayBlob(draw,width,height){
    const target=document.createElement('canvas');target.width=width;target.height=height;draw(target.getContext('2d'));const blob=await new Promise(resolve=>target.toBlob(resolve,'image/png'));target.width=target.height=0;if(!blob)throw new Error('Could not render Premiere overlay');return blob;
  }

  function imageAssetIdentity(clip){return clip.sourceAssetKey||clip.itemId;}

  async function transformedBoardImageAsset(clip,bitmap){
    const geometry=clipVisualGeometry(clip,bitmap);if(!geometry)return null;
    const nativeScale=Math.max(geometry.source.width/geometry.baseWidth,geometry.source.height/geometry.baseHeight);
    const edgeScale=8192/Math.max(geometry.rotatedWidth,geometry.rotatedHeight);
    const areaScale=Math.sqrt(32_000_000/Math.max(.001,geometry.rotatedWidth*geometry.rotatedHeight));
    const scale=Math.max(.001,Math.min(nativeScale,edgeScale,areaScale));
    const width=Math.max(1,Math.ceil(geometry.rotatedWidth*scale)),height=Math.max(1,Math.ceil(geometry.rotatedHeight*scale));
    const target=document.createElement('canvas');target.width=width;target.height=height;
    const targetCtx=target.getContext('2d');targetCtx.imageSmoothingEnabled=true;targetCtx.imageSmoothingQuality='high';drawClipVisual(targetCtx,clip,bitmap,width/2,height/2,scale);
    const blob=await new Promise(resolve=>target.toBlob(resolve,'image/png'));target.width=target.height=0;
    if(!blob)throw new Error(`Could not render transformed image: ${clip.name}`);return {blob,width,height};
  }

  async function collectTimelineExportAssets({fps,width,height,append,onProgress=()=>{}}){
    const assets=new Map(),jobs=[];
    const seenImages=new Set(),seenVideos=new Set(),seenAudio=new Set();
    for(const clip of project.clips){
      if(isVideoClip(clip)){if(!seenVideos.has(clip.mediaId)){seenVideos.add(clip.mediaId);jobs.push({key:`video:${clip.mediaId}`,kind:'video',entry:clip});}}
      else {const identity=imageAssetIdentity(clip);if(!seenImages.has(identity)){seenImages.add(identity);jobs.push({key:`image:${identity}`,kind:'image',entry:clip});}}
      if(clip.strokes?.length)jobs.push({key:`stroke:${clip.id}`,kind:'stroke',entry:clip});
    }
    for(const audio of project.audio)if(!seenAudio.has(audio.mediaId)){seenAudio.add(audio.mediaId);jobs.push({key:`audio:${audio.mediaId}`,kind:'audio',entry:audio});}
    let assetIndex=0;
    for(const job of jobs){
      let blob,name,meta;
      if(job.kind==='image'){
        const image=getImage(job.entry.itemId),identity=imageAssetIdentity(job.entry);let assetWidth=image?.w||0,assetHeight=image?.h||0;
        if(job.entry.boardTransform){const bitmap=await getBitmap(job.entry.itemId,{priority:'high'});if(!bitmap)throw new Error(`Missing transformed image: ${job.entry.name}`);const rendered=await transformedBoardImageAsset(job.entry,bitmap);blob=rendered.blob;assetWidth=rendered.width;assetHeight=rendered.height;name=`${String(job.entry.name||image?.name||`Image ${assetIndex+1}`).replace(/\.[^.]+$/,'')}.png`;}
        else {blob=await getBlob(job.entry.itemId);name=job.entry.name||image?.name||`Image ${assetIndex+1}`;}
        if(!blob?.size)throw new Error(`Missing original image: ${job.entry.name}`);meta={kind:'image',width:assetWidth,height:assetHeight,durationFrames:Math.max(1,...project.clips.filter(c=>!isVideoClip(c)&&imageAssetIdentity(c)===identity).map(c=>premiereFrame(c.duration,fps)))};
      }else if(job.kind==='video'){
        blob=job.entry.blob||mediaResources.get(job.entry.mediaId)?.blob;if(!blob?.size)throw new Error(`Missing video: ${job.entry.name}`);name=job.entry.name||`Video ${assetIndex+1}`;meta={kind:'video',width:job.entry.videoWidth||0,height:job.entry.videoHeight||0,durationFrames:premiereFrame(job.entry.originalDuration||job.entry.sourceOut||job.entry.duration,fps)};
      }else if(job.kind==='audio'){
        blob=job.entry.blob||mediaResources.get(job.entry.mediaId)?.blob;if(!blob?.size)throw new Error(`Missing audio: ${job.entry.name}`);name=job.entry.name||`Audio ${assetIndex+1}`;meta={kind:'audio',channels:2,durationFrames:premiereFrame(job.entry.originalDuration||job.entry.sourceOut||job.entry.duration,fps)};
      }else if(job.kind==='stroke'){
        blob=await premiereOverlayBlob(g=>drawClipDrawings(g,job.entry,width,height),width,height);name=`${String(job.entry.name||'Clip').replace(/\.[^.]+$/,'')} Drawings.png`;meta={kind:'image',width,height,durationFrames:premiereFrame(job.entry.duration,fps)};
      }
      const ext=premiereAssetExtension(name,blob,meta.kind),base=safePremiereAssetName(name,`Media ${assetIndex+1}${ext}`),fileName=/\.[A-Za-z0-9]{1,8}$/.test(base)?base:`${base}${ext}`;
      const category=job.kind==='stroke'?'drawing':job.kind;
      const written=await append({name:fileName,category,data:await blob.arrayBuffer()});assets.set(job.key,{id:`asset-${++assetIndex}`,name:written.name,filePath:written.filePath,relativePath:written.relativePath||written.name,category:written.category||category,...meta});onProgress(assetIndex,Math.max(1,jobs.length));
    }
    return assets;
  }

  async function exportPremiereProject(){
    if(!project.clips.length){notify('Add at least one clip');return;}
    const api=window.RefBoardAPI;if(!api?.beginPremiereExport){notify('Premiere export is available in the desktop build');return;}
    const fps=Number($('#anExportFps').value),res=Number($('#anExportRes').value),{width,height}=sequenceDimensions(res,project.aspect),useRange=$('#anExportRange').value==='inout'&&hasSequenceRange(),exportStart=useRange?project.inPoint:0,exportEnd=useRange?Math.min(duration(),project.outPoint):duration();
    if(exportEnd<=exportStart+MIN_SHOT_SECONDS){notify('The selected export range is empty');return;}
    project.fps=fps;project.resolution=res;const progress=$('#anExportProgress'),bar=progress.querySelector('i'),go=$('#anExportGo');progress.classList.add('show');go.disabled=true;let token=null;
    try{
      const stamp=new Date().toISOString().replace(/[:.]/g,'-'),begun=await api.beginPremiereExport({defaultName:`refboard-animatic-${stamp}.xml`});if(!begun?.started)return;token=begun.token;
      const assets=await collectTimelineExportAssets({fps,width,height,append:asset=>api.appendPremiereExportAsset(token,asset),onProgress:(done,total)=>bar.style.width=`${Math.round(done/total*82)}%`});
      const sequence=buildPremiereTimeline({project,name:'RefBoard Animatic',fps,width,height,exportStart,exportEnd,assets}),xml=createPremiereXml(sequence);bar.style.width='92%';const result=await api.finishPremiereExport(token,xml);token=null;bar.style.width='100%';$('#anExportModal').classList.remove('open');notify(result?.saved?'Premiere timeline and media exported':'Export canceled');
    }catch(err){console.error('[animatics] Premiere export failed',err);if(token)await api.abortPremiereExport?.(token).catch(()=>{});notify(`Premiere export failed${err?.message?` — ${err.message}`:''}`);}
    finally{go.disabled=false;setTimeout(()=>{progress.classList.remove('show');bar.style.width='0';},500);}
  }

  async function exportAfterEffectsProject(){
    if(!project.clips.length){notify('Add at least one clip');return;}
    const api=window.RefBoardAPI;if(!api?.beginAfterEffectsExport){notify('After Effects export is available in the desktop build');return;}
    const fps=Number($('#anExportFps').value),res=Number($('#anExportRes').value),{width,height}=sequenceDimensions(res,project.aspect),useRange=$('#anExportRange').value==='inout'&&hasSequenceRange(),exportStart=useRange?project.inPoint:0,exportEnd=useRange?Math.min(duration(),project.outPoint):duration();
    if(exportEnd<=exportStart+MIN_SHOT_SECONDS){notify('The selected export range is empty');return;}
    if(exportEnd-exportStart>AFTER_EFFECTS_MAX_SECONDS){notify('After Effects compositions are limited to 3 hours — set a shorter In to Out range');return;}
    project.fps=fps;project.resolution=res;const progress=$('#anExportProgress'),bar=progress.querySelector('i'),go=$('#anExportGo');progress.classList.add('show');go.disabled=true;let token=null;
    try{
      const stamp=new Date().toISOString().replace(/[:.]/g,'-'),begun=await api.beginAfterEffectsExport({defaultName:`refboard-animatic-${stamp}-after-effects.jsx`});if(!begun?.started)return;token=begun.token;
      const assets=await collectTimelineExportAssets({fps,width,height,append:asset=>api.appendAfterEffectsExportAsset(token,asset),onProgress:(done,total)=>bar.style.width=`${Math.round(done/total*82)}%`});
      const aeProject=buildAfterEffectsProject({project,name:'RefBoard Animatic',fps,width,height,exportStart,exportEnd,assets});
      const script=createAfterEffectsScript(aeProject,{mediaFolderName:begun.mediaFolderName,projectFileName:begun.projectFileName});bar.style.width='92%';
      const result=await api.finishAfterEffectsExport(token,script);token=null;bar.style.width='100%';$('#anExportModal').classList.remove('open');notify(result?.saved?'After Effects builder exported — run it in After Effects to create the .aep':'Export canceled');
    }catch(err){console.error('[animatics] After Effects export failed',err);if(token)await api.abortAfterEffectsExport?.(token).catch(()=>{});notify(`After Effects export failed${err?.message?` — ${err.message}`:''}`);}
    finally{go.disabled=false;setTimeout(()=>{progress.classList.remove('show');bar.style.width='0';},500);}
  }

  function releaseImportedMedia(){
    releaseVideoElements();releaseAudioPlaybackContext();audioWaveformEpoch++;audioWaveformCache.clear();audioWaveformJobs.clear();
    const urls=new Set([...mediaResources.values()].map(resource=>resource.url).filter(Boolean));
    for(const url of [...project.audio.map(a=>a.url),...project.clips.filter(isVideoClip).map(c=>c.url)].filter(Boolean))urls.add(url);
    for(const url of urls)URL.revokeObjectURL(url);mediaResources.clear();
  }

  function mediaEntries(){
    const entries=[...project.audio,...project.clips.filter(isVideoClip)],seen=new Set();
    return entries.filter(entry=>entry.blob&&entry.mediaId&&!seen.has(entry.mediaId)&&seen.add(entry.mediaId));
  }

  return {
    open: openEditor,
    close: closeEditor,
    addItems,
    addAudioFiles,
    addVideoFiles,
    trimAudioFile:openAudioTrimmer,
    undo:undoAnimatics,
    redo:redoAnimatics,
    historyState:()=>timelineHistory.sizes(),
    isOpen:()=>open,
    serialize:()=>({ ...structuredClone({...project,audio:[],clips:[]}), playhead:0, clips:project.clips.map(({blob,url,...c})=>({...c,needsRelink:isVideoClip(c)&&!blob})), audio:project.audio.map(({blob,url,...a})=>({...a,needsRelink:!blob})) }),
    mediaRefs:()=>mediaEntries().map(entry=>({id:entry.mediaId,type:entry.type||entry.blob.type||'application/octet-stream',name:entry.name,size:entry.blob.size})),
    getMediaBlob:mediaId=>mediaEntries().find(entry=>entry.mediaId===mediaId)?.blob||null,
    load:(raw,mediaBlobs)=>{releaseImportedMedia();clearActiveDrawingSession();activeStroke=null;drawingOverlayCache.clear();timelineClipboard=null;timelineFitZoom=null;activeVideoTrack=0;activeAudioTrack=0;project=normalizeProject(raw,mediaBlobs);rememberProjectMedia();const first=project.clips[0]?.id||project.texts[0]?.id||project.audio[0]?.id||null;setTimelineSelection(first?[first]:[],first);resetAnimaticsHistory();renderAll();},
    clear:()=>{releaseImportedMedia();clearActiveDrawingSession();activeStroke=null;drawingOverlayCache.clear();timelineClipboard=null;timelineFitZoom=null;activeVideoTrack=0;activeAudioTrack=0;project=freshProject();setTimelineSelection([]);resetAnimaticsHistory();renderAll();},
  };
}
