import {
  applyBatchTimelineDuration,
  closeTimelineTrackGap,
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

const MAX_VIDEO_TRACKS = 8;
const MAX_AUDIO_TRACKS = 5;
const DEFAULT_SHOT_SECONDS = 3;
const MIN_SHOT_SECONDS = 1 / 60;
const MAX_SEQUENCE_SECONDS = 24 * 60 * 60;
const SAFE_INITIAL_TIMELINE_PIXELS = 60000;
const HISTORY_LIMIT = 100;
const DEFAULT_TRACK_HEIGHT = 44;
const MIN_TRACK_HEIGHT = 24;
const MAX_TRACK_HEIGHT = 180;
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

export function timelineRulerStep(totalSeconds, pixelsPerSecond, maxTicks = 900) {
  const minimum = Math.max(72/Math.max(1,pixelsPerSecond),Math.max(0,totalSeconds)/maxTicks);
  const steps = [1/60,1/30,1/24,.1,.25,.5,1,2,5,10,15,30,60,120,300,600,900,1800,3600,7200,14400];
  return steps.find(step => step >= minimum) || Math.ceil(minimum/3600)*3600;
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
  body.animatics-open #status, body.animatics-open #credit, body.animatics-open #board,
  body.animatics-open #drawPanelWrap, body.animatics-open #addPanelWrap { visibility:hidden !important; pointer-events:none !important; }
  #animaticsWorkspace { --an-timeline-h:286px; position:fixed; inset:0; z-index:80; display:none; color:#eef0f5; color-scheme:dark; background:#0c0d10; font:12px/1.35 "Segoe UI",sans-serif; user-select:none; }
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
  .an-transport { display:flex; align-items:center; justify-content:center; gap:4px; min-width:310px; }
  .an-transport .an-icon { width:31px; height:31px; }
  .an-play { width:36px; height:36px; border-radius:50%; background:#f0f2f7; color:#101217; border:0; display:grid; place-items:center; cursor:pointer; }
  .an-play:hover { background:#fff; transform:scale(1.03); }
  .an-play svg { width:17px; height:17px; fill:currentColor; }
  .an-time { min-width:128px; text-align:center; color:#e9ebf1; font:600 12px/1.2 ui-monospace,Consolas,monospace; }
  .an-top-actions { display:flex; align-items:center; gap:7px; margin-left:auto; justify-content:flex-end; }
  .an-btn { height:34px; padding:0 12px; border-radius:9px; font-weight:600; }
  .an-btn.primary { color:#0c1118; background:#67aaff; }
  .an-btn.primary:hover { color:#081018; background:#86bbff; }
  .an-stage-row { display:grid; grid-template-columns:0 minmax(0,1fr) 0; min-height:0; overflow:hidden; background:#0d0f13; transition:grid-template-columns .22s ease; }
  #animaticsWorkspace.panel-open .an-stage-row { grid-template-columns:278px minmax(0,1fr) 0; }
  .an-side { min-width:0; overflow:hidden; border-right:1px solid #292c35; background:#15171c; }
  .an-side-inner { width:278px; height:100%; display:flex; flex-direction:column; }
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
  .an-split { display:grid; grid-template-columns:1fr 1fr; gap:9px; }
  .an-help { color:#7d8492; font-size:11px; line-height:1.5; }
  .an-tool-btn { width:100%; height:35px; margin-bottom:8px; border:1px solid #333743; border-radius:9px; background:#20232b; color:#d9dde6; cursor:pointer; }
  .an-tool-btn:hover,.an-tool-btn.on { border-color:#5aa2ff; color:#fff; background:#26384f; }
  .an-stage { min-width:0; min-height:0; position:relative; display:grid; place-items:center; padding:18px 38px 12px; overflow:hidden; }
  .an-viewer-wrap { width:min(100%, 960px); height:100%; min-height:0; display:grid; grid-template-rows:minmax(0,1fr) 44px; gap:8px; }
  .an-viewer-shell { min-height:0; position:relative; display:grid; place-items:center; justify-self:center; align-self:center; overflow:hidden; border-radius:7px; background:#050607; box-shadow:0 18px 60px rgba(0,0,0,.48); aspect-ratio:16/9; }
  #anViewer { display:block; width:100%; height:100%; background:#000; touch-action:none; }
  .an-inline-text { position:absolute; z-index:12; display:none; min-width:120px; min-height:42px; box-sizing:border-box; padding:7px 10px; border:1px solid #6baaff; border-radius:7px; outline:none; resize:none; overflow:hidden; color:#fff; background:rgba(8,11,17,.78); box-shadow:0 8px 24px rgba(0,0,0,.4),0 0 0 2px rgba(93,164,255,.18); text-align:center; font:600 24px "Segoe UI",sans-serif; line-height:1.18; transform-origin:center; user-select:text; }
  .an-inline-text.open { display:block; }
  .an-viewer-shell.framing { outline:2px solid #67aaff; outline-offset:3px; }
  .an-viewer-shell.framing::after { content:"Reframe · drag to position · wheel to scale · double-click to finish"; position:absolute; left:50%; bottom:12px; translate:-50% 0; padding:6px 10px; border-radius:7px; background:rgba(7,10,15,.78); color:#e7f1ff; font-size:10px; white-space:nowrap; pointer-events:none; }
  .an-empty-stage { position:absolute; inset:0; display:grid; place-items:center; color:#727987; text-align:center; pointer-events:none; }
  .an-empty-stage.hide { display:none; }
  .an-stage-foot { display:grid; grid-template-columns:minmax(120px,1fr) auto minmax(120px,1fr); align-items:center; gap:10px; color:#858c9a; }
  .an-stage-foot b { color:#d9dde5; font-weight:600; }
  .an-view-settings { justify-self:end; display:flex; align-items:center; gap:5px; }
  .an-view-settings select { height:28px; border:1px solid #30343e; border-radius:7px; background-color:#17191f; color:#aeb5c2; padding:0 25px 0 8px; outline:none; font:11px "Segoe UI",sans-serif; cursor:pointer; }
  .an-view-settings select:hover,.an-view-settings select:focus { border-color:#4e5666; color:#fff; }
  #anShotLabel { min-width:0; display:flex; align-items:center; overflow:hidden; white-space:nowrap; }
  .an-shot-name { min-width:0; max-width:min(42vw,320px); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .an-shot-meta { flex:0 0 auto; color:#9299a7; white-space:nowrap; }
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
  .an-tl-scroll::-webkit-scrollbar-track:horizontal { margin-left:124px; }
  .an-panel::-webkit-scrollbar-thumb,.an-tl-scroll::-webkit-scrollbar-thumb { border:2px solid #15181e; border-radius:99px; background:#414754; }
  .an-panel::-webkit-scrollbar-thumb:hover,.an-tl-scroll::-webkit-scrollbar-thumb:hover { background:#566070; }
  .an-tl-grid { min-width:100%; min-height:100%; position:relative; padding-bottom:12px; box-sizing:border-box; }
  .an-ruler-row,.an-track-row { display:grid; grid-template-columns:124px minmax(900px,1fr); }
  .an-ruler-row { height:32px; min-height:32px; position:sticky; top:0; z-index:8; background:#14161b; }
  .an-track-row { position:relative; height:var(--an-track-height,44px); min-height:24px; }
  .an-track-label { position:sticky; left:0; z-index:7; display:flex; align-items:center; gap:6px; min-height:0; padding:0 8px 0 6px; color:#9ca3b0; background:#17191f; border-right:1px solid #2b2e37; border-bottom:1px solid #242730; }
  .an-track-label b { color:#dfe2e8; font-size:11px; }
  .an-track-target { min-width:28px; height:24px; padding:0 5px; border:1px solid transparent; border-radius:6px; color:#dfe2e8; background:transparent; font:700 11px "Segoe UI",sans-serif; cursor:pointer; }
  .an-track-target:hover,.an-track-target:focus-visible { color:#f3f8ff; background:#293547; outline:none; }
  .an-track-target.on { border-color:#5a9de7; color:#eaf5ff; background:#28496d; box-shadow:inset 0 0 0 1px rgba(130,190,255,.2),0 0 9px rgba(74,145,226,.2); }
  .an-track-label span { margin-left:auto; color:#636a77; font-size:10px; }
  .an-track-grip { width:20px; height:24px; padding:0; border:0; display:grid; place-items:center; border-radius:5px; color:#717987; background:transparent; cursor:grab; touch-action:none; }
  .an-track-grip:hover,.an-track-grip:focus-visible { color:#d8e8fb; background:#293547; outline:none; }
  .an-track-grip:active { cursor:grabbing; }
  .an-track-grip svg { width:12px; height:14px; fill:currentColor; }
  .an-time-mode { height:24px; padding:0 6px; border:0; border-radius:5px; color:#8f98a8; background:transparent; font:700 9px ui-monospace,Consolas,monospace; letter-spacing:.04em; cursor:pointer; }
  .an-time-mode:hover,.an-time-mode:focus-visible { color:#dcecff; background:#293547; outline:none; }
  .an-track-remove { width:21px; height:21px; margin-left:0; padding:0; border:1px solid transparent; border-radius:5px; display:grid; place-items:center; opacity:0; color:#8f98a8; background:transparent; cursor:pointer; transition:.12s; }
  .an-track-label:hover .an-track-remove,.an-track-remove:focus-visible { opacity:1; }
  .an-track-remove:hover { border-color:#71434b; color:#ffd9df; background:#45272d; }
  .an-track-remove svg { width:11px; height:11px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; }
  .an-track-visibility { width:23px; height:23px; flex:0 0 auto; padding:0; border:1px solid transparent; border-radius:5px; display:grid; place-items:center; color:#b7c5d8; background:transparent; cursor:pointer; transition:.12s; }
  .an-track-visibility:hover,.an-track-visibility:focus-visible { color:#e9f4ff; background:#293547; outline:none; }
  .an-track-visibility.off { color:#68717f; background:#202329; }
  .an-track-visibility svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
  .an-track-lane { position:relative; border-bottom:1px solid #242730; background-image:linear-gradient(90deg,rgba(255,255,255,.025) 1px,transparent 1px); background-size:var(--an-second-px,90px) 100%; touch-action:none; }
  .an-track-resize { position:absolute; z-index:12; left:0; right:0; bottom:-3px; height:7px; padding:0; border:0; background:transparent; cursor:row-resize; touch-action:none; }
  .an-track-resize::after { content:""; position:absolute; left:124px; right:0; top:3px; height:1px; background:transparent; }
  .an-track-resize:hover::after,.an-track-resize.dragging::after { background:#6aaaff; box-shadow:0 0 7px rgba(106,170,255,.55); }
  .an-track-row.reorder-source { opacity:.58; }
  .an-track-row.reorder-target::after { content:""; position:absolute; z-index:11; inset:1px 0; border:1px solid #70aff5; background:rgba(77,145,222,.09); pointer-events:none; }
  .an-ruler { position:relative; border-bottom:1px solid #30333c; cursor:pointer; touch-action:none; }
  .an-tick { position:absolute; inset-block:0 auto; padding:7px 0 0 5px; color:#6f7683; font:10px ui-monospace,Consolas,monospace; border-left:1px solid #343741; }
  .an-clip { position:absolute; z-index:2; top:3px; bottom:4px; min-width:16px; min-height:14px; border:1px solid #4d77aa; border-radius:6px; overflow:hidden; cursor:pointer; background:#243a55; color:#e7effb; box-shadow:0 2px 8px rgba(0,0,0,.25); transition:opacity .15s ease,transform .15s ease,box-shadow .15s ease; }
  .an-clip:hover,.an-clip.on { border-color:#79b6ff; box-shadow:0 0 0 1px rgba(90,162,255,.3),0 4px 12px rgba(0,0,0,.4); }
  .an-clip.primary { box-shadow:0 0 0 2px rgba(118,190,255,.72),0 4px 14px rgba(0,0,0,.48); }
  .an-clip.clip-disabled,.an-track-row.track-disabled .an-clip { opacity:.38; filter:saturate(.32); border-style:dashed; }
  .an-clip.clip-disabled.on,.an-clip.clip-disabled.primary,.an-track-row.track-disabled .an-clip.on,.an-track-row.track-disabled .an-clip.primary { opacity:.62; }
  .an-track-row.track-disabled .an-track-lane { background-color:rgba(0,0,0,.16); }
  .an-clip.dragging-source { opacity:.28; transform:scale(.975); box-shadow:none; }
  .an-drag-ghost { position:fixed!important; z-index:70; bottom:auto; pointer-events:none; opacity:.8; transform:scale(1.015); box-shadow:0 12px 28px rgba(0,0,0,.48),0 0 0 1px rgba(114,180,255,.5)!important; transition:top .13s ease,left .05s linear,opacity .13s ease,transform .13s ease; }
  .an-track-lane.an-lane-hover { background-color:rgba(89,156,239,.11); box-shadow:inset 0 0 0 1px rgba(103,170,255,.38); }
  .an-clip img { width:clamp(24px,calc(var(--an-track-height,44px) - 2px),150px); height:100%; object-fit:cover; float:left; margin-right:7px; background:#0d0f13; pointer-events:none; }
  .an-clip-name { position:relative; z-index:2; display:block; max-width:calc(100% - 14px); margin-top:4px; padding-right:15px; box-sizing:border-box; font-size:10px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; text-shadow:0 1px 3px rgba(0,0,0,.9); }
  .an-clip-dur { position:relative; z-index:2; display:block; color:#a9bed7; font-size:9px; text-shadow:0 1px 3px rgba(0,0,0,.9); }
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
  .an-snap-guide { position:absolute; z-index:25; top:0; bottom:0; left:124px; display:none; width:1px; background:#69aeff; box-shadow:0 0 8px rgba(105,174,255,.7); pointer-events:none; }
  .an-snap-guide.show { display:block; }
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
  .an-track-add { position:sticky; left:132px; z-index:24; display:block; width:max-content; height:32px; padding:0 10px; margin:6px 0 2px 132px; border-radius:8px; border-color:#30343e; font-size:11px; background:#17191f; box-shadow:0 0 0 4px #15181e; }
  .an-playhead { position:absolute; z-index:20; top:0; bottom:0; left:124px; width:1px; background:#ff6b6b; pointer-events:none; transform:translateX(var(--an-playhead-x,0px)); }
  .an-playhead.out-of-view { display:none; }
  .an-playhead::before { content:""; position:absolute; top:0; left:0; width:11px; height:8px; border-radius:2px 2px 5px 5px; background:#ff6b6b; }
  .an-sequence-range { position:absolute; z-index:1; top:0; bottom:0; left:124px; pointer-events:none; background:rgba(94,165,255,.07); border-inline:1px solid rgba(94,165,255,.35); transform:translateX(var(--an-in-x,0)); width:var(--an-range-w,0); }
  .an-sequence-marker { position:absolute; z-index:22; top:0; bottom:0; left:124px; width:9px; cursor:ew-resize; touch-action:none; background:transparent; transform:translateX(var(--an-marker-x,0)); }
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
  .an-sequence-presets { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin:4px 0 14px; }
  .an-sequence-presets button { height:30px; border:1px solid #343946; border-radius:7px; color:#aeb7c6; background:#151820; cursor:pointer; }
  .an-sequence-presets button:hover { border-color:#5b9eea; color:#eff7ff; background:#24364c; }
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
  @media(max-width:900px){ #animaticsWorkspace.panel-open .an-stage-row{grid-template-columns:236px minmax(0,1fr) 0}.an-side-inner{width:236px}.an-top-actions{min-width:auto}.an-brand{min-width:auto}.an-stage{padding-inline:12px}.an-stage-foot{grid-template-columns:1fr auto}.an-stage-foot #anShotLabel{display:none}.an-transport{min-width:0} }
  `;
}

function icon(path, fill = false) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"${fill ? ' style="fill:currentColor;stroke:none"' : ''}>${path}</svg>`;
}

function selectionToolIcon(){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.9 2.45c-.72-.31-1.48.34-1.32 1.11l3.33 16.08c.17.84 1.26 1.09 1.78.4l3.46-4.61 5.12 4.06a1 1 0 0 0 1.4-.16l1.35-1.7a1 1 0 0 0-.16-1.41l-5.03-3.99 5.48-2.2c.8-.32.82-1.45.03-1.79Z" fill="#f7f9fc" stroke="#080b10" stroke-width="1.35" stroke-linejoin="round"/><path d="m11.15 15.43 1.18-1.57" fill="none" stroke="#4b94df" stroke-width="1.15" stroke-linecap="round"/></svg>';}
function razorToolIcon(){return '<svg viewBox="0 0 32 32" aria-hidden="true"><g transform="rotate(-28 16 16)" stroke-linejoin="round"><path d="M5 6h22v13l-8 7H5Z" fill="#080a0e" stroke="currentColor" stroke-width="1.8"/><path d="M5 20h13l9-8v7l-8 7H5Z" fill="#70b5ff" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="13" r="2.2" fill="none" stroke="currentColor" stroke-width="1.5"/></g></svg>';}
function handToolIcon(){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.1 11.2V7.6a1.45 1.45 0 0 1 2.9 0v2.1-4a1.5 1.5 0 0 1 3 0v3.7-2.8a1.45 1.45 0 0 1 2.9 0v3.3-1.7a1.4 1.4 0 0 1 2.8 0v5.3c0 4.5-2.7 7.1-6.8 7.1-2.6 0-4.2-1.2-5.5-3.1l-2.3-3.4a1.55 1.55 0 0 1 2.4-1.9Z" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"/></svg>';}
function linkToolIcon(){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.4 14.6 5.2-5.2M7.8 16.2l-1.1 1.1a3.2 3.2 0 0 1-4.5-4.5l3.1-3.1a3.2 3.2 0 0 1 4.5 0M16.2 7.8l1.1-1.1a3.2 3.2 0 0 1 4.5 4.5l-3.1 3.1a3.2 3.2 0 0 1-4.5 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';}
function visibilityIcon(visible=true){return visible?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.7"/></svg>':'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.4 6.2A10.8 10.8 0 0 1 12 6c6 0 9.5 6 9.5 6a16.7 16.7 0 0 1-3.1 3.7M6.2 6.3C3.8 8 2.5 12 2.5 12s3.5 6 9.5 6c1.5 0 2.8-.4 4-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';}

function markup() {
  return `<section id="animaticsWorkspace" aria-hidden="true">
    <header class="an-top">
      <div class="an-brand"><button class="an-back" id="anBack" title="Back to board">${icon('<path d="m15 18-6-6 6-6"/>')}</button><div class="an-brand-lockup"><img class="an-brand-mark" id="anBrandMark" alt="" aria-hidden="true"><span class="an-brand-name">RefBoard</span><span class="an-title">Animatics</span></div></div>
      <div class="an-top-actions"><button class="an-btn" id="anInspector">Tools</button><button class="an-btn primary" id="anExport">Export</button></div>
    </header>
    <div class="an-stage-row">
      <aside class="an-side"><div class="an-side-inner">
        <nav class="an-tabs"><button class="an-tab on" data-panel="clip">Clip</button><button class="an-tab" data-panel="text">Text</button><button class="an-tab" data-panel="audio">Audio</button><button class="an-tab" data-panel="draw">Draw</button><button class="an-tab" data-panel="view">View</button></nav>
        <div class="an-panel on" data-panel-body="clip"><h3 class="an-section-title" id="anClipSelectionTitle">Selected clip</h3><div class="an-split"><label class="an-field">Seconds<input id="anDuration" type="number" min="0.017" max="600" step="0.1" placeholder="Mixed"></label><label class="an-field">Frames<input id="anDurationFrames" type="number" min="1" max="36000" step="1" placeholder="Mixed"></label></div><h3 class="an-section-title" id="anFramingTitle">16:9 framing</h3><div class="an-frame-actions"><button class="an-tool-btn" id="anFrameFit">Fit</button><button class="an-tool-btn" id="anFrameFill">Fill</button><button class="an-tool-btn" id="anFrameReset">Reset</button></div><label class="an-field">Scale<div class="an-scale-row"><input id="anFrameScale" type="range" min="25" max="400" value="100"><output id="anFrameScaleVal">100%</output></div></label><button class="an-tool-btn" id="anToggleClipVisibility" title="Enable or disable selected visual clips (Ctrl+H)" aria-pressed="false">Disable selected</button><div class="an-split"><button class="an-tool-btn" id="anSplit">Split at playhead</button><button class="an-tool-btn" id="anDeleteClip">Delete selected</button></div><p class="an-help">Framing and visibility apply to every selected image or video. Duration applies to selected visual and audio clips.</p></div>
        <div class="an-panel" data-panel-body="text"><h3 class="an-section-title">Text overlay layer</h3><label class="an-field">Content<textarea id="anText" placeholder="Add a title or annotation…"></textarea></label><div class="an-split"><label class="an-field">Font size<input id="anTextSize" type="number" min="8" max="300" value="42"></label><label class="an-field">Color<input id="anTextColor" type="color" value="#ffffff"></label></div><label class="an-field">Scale<div class="an-scale-row"><input id="anTextScale" type="range" min="25" max="400" value="100"><output id="anTextScaleVal">100%</output></div></label><div class="an-split"><label class="an-field">Rotation<input id="anTextRotation" type="number" min="-180" max="180" value="0"></label><label class="an-field">Duration (sec)<input id="anTextDuration" type="number" min="0.017" max="600" step="0.1" value="3"></label></div><div class="an-split"><label class="an-field">X position %<input id="anTextX" type="number" min="0" max="100" value="50"></label><label class="an-field">Y position %<input id="anTextY" type="number" min="0" max="100" value="82"></label></div><button class="an-tool-btn" id="anAddText">Add text layer</button><button class="an-tool-btn" id="anClearText">Delete selected text</button><p class="an-help">Press T, then click directly in the preview to place and type text. Text remains editable on the T1 timeline layer.</p></div>
        <div class="an-panel" data-panel-body="audio"><h3 class="an-section-title" id="anAudioSelectionTitle">Selected audio</h3><div class="an-split"><label class="an-field">Seconds<input id="anAudioDuration" type="number" min="0.017" max="600" step="0.1" placeholder="Mixed"></label><label class="an-field">Frames<input id="anAudioDurationFrames" type="number" min="1" max="36000" step="1" placeholder="Mixed"></label></div><label class="an-field">Volume<div class="an-scale-row"><input id="anAudioVolume" type="range" min="0" max="200" step="1" value="100"><output id="anAudioVolumeVal">100%</output></div></label><button class="an-tool-btn" id="anAudioMute">Mute selected</button><div class="an-split"><button class="an-tool-btn" id="anAudioSplit">Split at playhead</button><button class="an-tool-btn" id="anAudioDelete">Delete selected</button></div><p class="an-help">Duration applies to selected visual and audio clips. Volume applies to every selected audio clip.</p></div>
        <div class="an-panel" data-panel-body="draw"><h3 class="an-section-title">Draw on shot</h3><div class="an-split"><label class="an-field">Color<input id="anDrawColor" type="color" value="#ff5c5c"></label><label class="an-field">Width<input id="anDrawWidth" type="number" min="1" max="40" value="6"></label></div><button class="an-tool-btn" id="anDrawToggle">Start drawing</button><button class="an-tool-btn" id="anClearDraw">Clear drawing</button><p class="an-help">Draw directly on the viewer. Strokes are stored as lightweight normalized points, not extra image copies.</p></div>
        <div class="an-panel" data-panel-body="view"><h3 class="an-section-title">Viewer</h3><div class="an-split"><label class="an-field">Playback counter<select id="anCounterMode"><option value="timecode">Timecode</option><option value="frames">Frames</option><option value="seconds">Seconds</option></select></label><label class="an-field">Project rate<select id="anProjectFps"><option value="24">24 fps</option><option value="30">30 fps</option><option value="60">60 fps</option></select></label></div><button class="an-tool-btn" id="anTcToggle">Show counter in picture</button><label class="an-field">Background<select id="anBackground"><option value="#000000">Black</option><option value="#181a20">Charcoal</option><option value="#ffffff">White</option></select></label><p class="an-help">Use the compact controls below the viewer for sequence shape and playback quality. Export always uses the original full-resolution images.</p></div>
      </div></aside>
      <main class="an-stage"><div class="an-viewer-wrap"><div class="an-viewer-shell"><canvas id="anViewer" width="1920" height="1080"></canvas><div class="an-empty-stage" id="anEmpty"><div>No clips at the playhead<br><small>Add or move images in the timeline</small></div></div></div><div class="an-stage-foot"><span id="anShotLabel">No shot selected</span><div class="an-transport"><button class="an-icon" id="anPrev" title="Previous frame">${icon('<path d="M7 5v14M18 6l-8 6 8 6z"/>')}</button><button class="an-play" id="anPlay" title="Play / pause">${icon('<path d="m8 5 11 7-11 7z"/>',true)}</button><button class="an-icon" id="anNext" title="Next frame">${icon('<path d="M17 5v14M6 6l8 6-8 6z"/>')}</button><span class="an-time" id="anTime">00:00:00:00 / 00:00:00:00</span></div><div class="an-view-settings"><select id="anFooterAspect" aria-label="Sequence aspect"><option value="16:9">16:9</option><option value="4:3">4:3</option><option value="5:4">5:4</option><option value="9:16">9:16</option><option value="21:9">21:9</option></select><select id="anFooterQuality" aria-label="Preview quality"><option value="full">Full 1080p</option><option value="half">Half 540p</option><option value="low">Low 270p</option></select></div></div></div></main><aside></aside>
    </div>
    <section class="an-timeline"><div class="an-timeline-resizer" id="anTimelineResizer" role="separator" aria-label="Resize timeline" aria-orientation="horizontal" tabindex="0" title="Drag to resize timeline · double-click to reset"></div><div class="an-tl-head"><div class="an-edit-tools" role="toolbar" aria-label="Timeline tools"><button class="an-edit-tool on" data-an-tool="select" title="Selection tool (V)" aria-label="Selection tool">${selectionToolIcon()}</button><button class="an-edit-tool" data-an-tool="text" title="Text tool (T)" aria-label="Text tool"><span class="text-glyph">T</span></button><button class="an-edit-tool" data-an-tool="razor" title="Razor tool (C)" aria-label="Razor tool">${razorToolIcon()}</button></div><button class="an-icon an-snap-btn on" id="anSnap" title="Timeline snapping (S)" aria-pressed="true">⌁ Snap</button><button class="an-icon" id="anAddImages" title="Add selected board images">${icon('<path d="M12 5v14M5 12h14"/>')}</button><button class="an-icon" id="anAddVideo" title="Add video">${icon('<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>')}</button><button class="an-icon" id="anAddAudio" title="Add audio">${icon('<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>')}</button><button class="an-mark-btn" id="anSequenceSettings" title="Sequence duration and timeline display">Sequence</button><button class="an-mark-btn" id="anSetIn" title="Set sequence In point (I)">Set In</button><button class="an-mark-btn" id="anSetOut" title="Set sequence Out point (O)">Set Out</button><button class="an-mark-btn" id="anClearRange" title="Clear sequence In/Out">Clear</button><span id="anTlSummary">0 clips · 0:00</span><label class="an-zoom">Timeline <input id="anZoom" type="range" min="0.1" max="320" step="0.1" value="90"></label></div><div class="an-tl-scroll" id="anTlScroll"><div class="an-tl-grid" id="anTlGrid"><div class="an-playhead"></div></div></div><div class="an-marquee" id="anMarquee"></div><div class="an-razor-guide" id="anRazorGuide"><span></span></div></section>
    <input id="anAudioPick" type="file" accept="audio/*" multiple hidden>
    <input id="anVideoPick" type="file" accept="video/*" multiple hidden>
    <div class="an-toast" id="anToast"></div>
    <div class="an-export-modal" id="anSequenceModal"><div class="an-export-card"><h2>Sequence settings</h2><p>Choose a fixed timeline length or let the sequence follow its content.</p><div class="an-split"><label class="an-field">Length mode<select id="anSequenceMode"><option value="auto">Auto — fit content</option><option value="fixed">Fixed duration</option></select></label><label class="an-field">Timeline display<select id="anTimelineDisplay"><option value="timecode">Timecode</option><option value="frames">Frames</option></select></label></div><label class="an-field">Duration<input id="anSequenceDuration" type="text" inputmode="numeric" spellcheck="false" placeholder="00:03:00:00"></label><div class="an-sequence-hint"><span>HH:MM:SS:FF</span><span id="anSequenceMinimum"></span></div><div class="an-sequence-presets"><button data-sequence-seconds="180">3 min</button><button data-sequence-seconds="3600">1 hour</button><button data-sequence-seconds="14400">4 hours</button><button data-sequence-seconds="18000">5 hours</button></div><div class="an-export-actions"><button class="an-btn" id="anSequenceCancel">Cancel</button><button class="an-btn primary" id="anSequenceApply">Apply</button></div></div></div>
    <div class="an-export-modal" id="anExportModal"><div class="an-export-card"><h2>Export animatic</h2><p id="anExportDescription">MP4 · H.264 · stereo audio · <span id="anExportAspect">16:9</span></p><label class="an-field">Format<select id="anExportFormat"><option value="mp4">MP4 video</option><option value="premiere">Premiere Pro 2025–2026 timeline (.xml)</option><option value="after-effects">After Effects project builder (.jsx → .aep)</option></select></label><div class="an-split"><label class="an-field">Resolution<select id="anExportRes"><option value="1080">1080p</option><option value="720">720p</option><option value="480">480p</option></select></label><label class="an-field">Frame rate<select id="anExportFps"><option value="24">24 fps</option><option value="30" selected>30 fps</option><option value="60">60 fps</option></select></label></div><label class="an-field">Export range<select id="anExportRange"><option value="full">Full sequence</option><option value="inout">Sequence In to Out</option></select></label><label class="an-field" id="anExportCounterField">Counter overlay<select id="anExportTc"><option value="project">Use viewer setting</option><option value="on">Burn selected counter</option><option value="off">No counter</option></select></label><div class="an-progress" id="anExportProgress"><i></i></div><div class="an-export-actions"><button class="an-btn" id="anExportCancel">Cancel</button><button class="an-btn primary" id="anExportGo">Export MP4</button></div></div></div>
    <div class="an-audio-trim-modal" id="anAudioTrimModal"><div class="an-audio-trim-card"><h2>Trim audio</h2><p class="an-audio-trim-name" id="anTrimName">Audio</p><div class="an-wave-shell" id="anTrimWaveShell"><canvas id="anTrimWave" width="1200" height="260"></canvas><span class="an-trim-readout" id="anTrimReadout">00:00:00:00</span></div><audio id="anTrimPlayer" controls preload="metadata"></audio><div class="an-trim-points"><div class="an-trim-point"><h4>In point</h4><label class="an-field">Frame<input id="anTrimInFrames" type="number" min="0" step="1"></label><button class="an-tool-btn" id="anTrimSetIn">Set In at playhead</button></div><div class="an-trim-point"><h4>Out point</h4><label class="an-field">Frame<input id="anTrimOutFrames" type="number" min="1" step="1"></label><button class="an-tool-btn" id="anTrimSetOut">Set Out at playhead</button></div></div><div class="an-trim-summary"><span>Selected range</span><b id="anTrimSummary">0 frames · 0.00s</b></div><div class="an-trim-actions"><button class="an-btn" id="anTrimPlaySelection">Play selection</button><button class="an-btn" id="anTrimCancel">Cancel</button><button class="an-btn primary" id="anTrimUse">Use audio</button></div></div></div>
  </section>`;
}

export function createAnimaticsEditor(options) {
  const { getImage, getBitmap, getBlob, onDirty = () => {}, onOpen = () => {}, onClose = () => {}, toast: boardToast = () => {} } = options;
  const style = document.createElement('style');
  style.id = 'animaticsStyles';
  style.textContent = css();
  document.head.append(style);
  document.body.insertAdjacentHTML('beforeend', markup());

  const root = document.querySelector('#animaticsWorkspace');
  root.querySelector('.an-edit-tools')?.insertAdjacentHTML('beforeend',`<button class="an-edit-tool" data-an-tool="hand" title="Hand tool (H)" aria-label="Hand tool">${handToolIcon()}</button><span class="an-edit-divider" aria-hidden="true"></span><button class="an-edit-tool" id="anLink" title="Link selected clips (Ctrl+L)" aria-label="Link selected clips" aria-pressed="false">${linkToolIcon()}</button>`);
  const canonicalBrandMark=document.querySelector('#landingBrandIcon')?.currentSrc||document.querySelector('#landingBrandIcon')?.src||document.querySelector('#titlebarIcon')?.currentSrc||document.querySelector('#titlebarIcon')?.src||'';
  if(canonicalBrandMark)root.querySelector('#anBrandMark').src=canonicalBrandMark;
  const canvas = root.querySelector('#anViewer');
  const ctx = canvas.getContext('2d');
  const inlineTextEditor=document.createElement('textarea');inlineTextEditor.className='an-inline-text';inlineTextEditor.setAttribute('aria-label','Edit text on canvas');canvas.parentElement.append(inlineTextEditor);
  const inlineTextDismissEvents=new WeakSet();
  const grid = root.querySelector('#anTlGrid');
  const scroll = root.querySelector('#anTlScroll');
  const $ = selector => root.querySelector(selector);
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
  let activeStroke = null;
  let thumbUrls = new Map();
  let toastTimer = 0;
  let dragging = null;
  let handPan = null;
  let spaceHand = null;
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
  let audioTrimState = null;
  let audioTrimResolve = null;
  let trimWavePeaks = [];
  let trimHandleDrag = null;
  let timelineResize = null;
  let trackResize = null;
  let trackReorder = null;
  let textDrag = null;
  let inlineTextId = null;
  let inlineTextOriginal = '';
  let sequenceMarkerDrag = null;
  let razorHoverClip = null;
  let deferredHistoryTimer = 0;
  const videoElements = new Map();

  function freshProject() {
    return { version:7, fps:30, resolution:1080, aspect:'16:9', playhead:0, inPoint:null, outPoint:null, sequenceDuration:null, timelineDisplay:'timecode', timelineZoom:90, timelineHeight:286, timelineSnap:true, timecode:false, counterMode:'timecode', previewQuality:'full', background:'#000000', videoTracks:1, audioTracks:0, videoTrackHeights:[DEFAULT_TRACK_HEIGHT], videoTrackEnabled:[true], audioTrackHeights:[], clips:[], texts:[], audio:[] };
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
      audioTrackHeights:[...(source.audioTrackHeights||[])],
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
    project=cloneProjectForHistory(state.project);
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

  function duration() { return fixedSequenceEnd() ?? contentDuration(); }

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
    selectedTimelineIds=new Set([...ids].filter(id=>entryById(id)));
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

  function normalizedTrackHeights(values,count){return Array.from({length:count},(_,index)=>clamp(Number(values?.[index])||DEFAULT_TRACK_HEIGHT,MIN_TRACK_HEIGHT,MAX_TRACK_HEIGHT));}
  function normalizedTrackEnabled(values,count){return Array.from({length:count},(_,index)=>values?.[index]!==false);}
  function ensureTrackHeightCounts(){project.videoTrackHeights=normalizedTrackHeights(project.videoTrackHeights,project.videoTracks);project.videoTrackEnabled=normalizedTrackEnabled(project.videoTrackEnabled,project.videoTracks);project.audioTrackHeights=normalizedTrackHeights(project.audioTrackHeights,project.audioTracks);}
  function trackHeights(kind){return kind==='audio'?project.audioTrackHeights:project.videoTrackHeights;}
  function trackHeight(kind,track){return clamp(Number(trackHeights(kind)?.[track])||DEFAULT_TRACK_HEIGHT,MIN_TRACK_HEIGHT,MAX_TRACK_HEIGHT);}
  function setTrackHeight(kind,track,height){ensureTrackHeightCounts();trackHeights(kind)[track]=clamp(height,MIN_TRACK_HEIGHT,MAX_TRACK_HEIGHT);}
  function syncActiveTrackTargets(){activeVideoTrack=clamp(Math.round(Number(activeVideoTrack)||0),0,Math.max(0,project.videoTracks-1));activeAudioTrack=clamp(Math.round(Number(activeAudioTrack)||0),0,Math.max(0,project.audioTracks-1));}
  function reorderedTrackTarget(active,from,to){if(active===from)return to;if(from<to&&active>from&&active<=to)return active-1;if(from>to&&active>=to&&active<from)return active+1;return active;}
  function setActiveTimelineTrack(kind,track){
    const count=kind==='audio'?project.audioTracks:project.videoTracks;if(!Number.isInteger(track)||track<0||track>=count)return false;
    if(kind==='audio')activeAudioTrack=track;else activeVideoTrack=track;renderTimeline();notify(`${kind==='audio'?'A':'V'}${track+1} paste target active`);return true;
  }
  function isVideoTrackEnabled(track){return project.videoTrackEnabled?.[track]!==false;}
  function isVisualClipEnabled(clip){return clip?.enabled!==false;}
  function isVisualClipVisible(clip){return isVisualClipEnabled(clip)&&isVideoTrackEnabled(Number(clip?.track)||0);}

  function moveTimelineTrack(kind,from,to){
    const video=kind==='video',count=video?project.videoTracks:project.audioTracks;if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<0||from>=count||to>=count||from===to)return false;
    if(video)project.clips=reorderTimelineTracks(project.clips,from,to);else project.audio=reorderTimelineTracks(project.audio,from,to);
    ensureTrackHeightCounts();const heights=trackHeights(kind),[height]=heights.splice(from,1);heights.splice(to,0,height);if(video){const [enabled]=project.videoTrackEnabled.splice(from,1);project.videoTrackEnabled.splice(to,0,enabled!==false);activeVideoTrack=reorderedTrackTarget(activeVideoTrack,from,to);}else activeAudioTrack=reorderedTrackTarget(activeAudioTrack,from,to);return true;
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

  function isVideoClip(clip) {
    return clip?.mediaKind === 'video';
  }

  function isVideoFile(file){return String(file?.type||'').startsWith('video/')||/\.(mp4|mov|m4v|webm|avi|mkv|mpeg|mpg|ogv)$/i.test(String(file?.name||''));}

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
    base.timelineSnap = raw.timelineSnap !== false;
    base.sequenceDuration = Number.isFinite(Number(raw.sequenceDuration))&&Number(raw.sequenceDuration)>0 ? clamp(Number(raw.sequenceDuration),MIN_SHOT_SECONDS,MAX_SEQUENCE_SECONDS) : null;
    base.timelineDisplay = raw.timelineDisplay==='frames'?'frames':'timecode';
    base.timelineZoom = Number.isFinite(Number(raw.timelineZoom))&&Number(raw.timelineZoom)>0 ? clamp(Number(raw.timelineZoom),.1,320) : Number.isFinite(base.sequenceDuration)?clamp(SAFE_INITIAL_TIMELINE_PIXELS/base.sequenceDuration,.1,90):90;
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
      return {
        id:String(c.id||uid()), itemId:mediaKind==='image'?String(c.itemId):null, mediaKind, mediaId,
        track:clamp(Number(c.track)||0,0,MAX_VIDEO_TRACKS-1), start:Math.max(0,Number(c.start)||0), duration:mediaKind==='video'?sourceOut-sourceIn:requestedDuration,
        sourceIn,sourceOut,originalDuration,name:String(c.name||(mediaKind==='video'?'Video':'Shot')),type:String(c.type||blob?.type||(mediaKind==='video'?'video/mp4':'image/png')),
        blob,url:blob?URL.createObjectURL(blob):null,needsRelink:mediaKind==='video'&&!blob,videoWidth:Math.max(0,Number(c.videoWidth)||0),videoHeight:Math.max(0,Number(c.videoHeight)||0),
        enabled:c.enabled!==false,
        framing:{fit:c.framing?.fit==='cover'?'cover':'contain',scale:clamp(Number(c.framing?.scale)||1,.25,4),x:clamp(Number(c.framing?.x)||0,-1,1),y:clamp(Number(c.framing?.y)||0,-1,1)},
        strokes:Array.isArray(c.strokes)?c.strokes:[],
        ...(typeof c.linkGroupId==='string'&&c.linkGroupId?{linkGroupId:c.linkGroupId}:{}),
      };
    });
    base.texts=(Array.isArray(raw.texts)?raw.texts:[]).map(t=>({
      id:String(t.id||uid()),track:0,start:Math.max(0,Number(t.start)||0),duration:clamp(Number(t.duration)||DEFAULT_SHOT_SECONDS,MIN_SHOT_SECONDS,600),
      content:String(t.content||''),size:clamp(Number(t.size)||42,8,300),color:/^#[0-9a-f]{6}$/i.test(t.color)?t.color:'#ffffff',
      scale:clamp(finiteOr(t.scale,1),.25,4),rotation:clamp(finiteOr(t.rotation,0),-180,180),x:clamp(finiteOr(t.x,.5),0,1),y:clamp(finiteOr(t.y,.82),0,1),
    })).filter(t=>t.content);
    for(const rawClip of Array.isArray(raw.clips)?raw.clips:[]){
      if(!rawClip?.text?.content)continue;
      const clip=base.clips.find(c=>c.id===String(rawClip.id));if(!clip)continue;
      base.texts.push({id:uid(),track:0,start:clip.start,duration:clip.duration,content:String(rawClip.text.content),size:clamp(Number(rawClip.text.size)||42,8,300),color:String(rawClip.text.color||'#ffffff'),scale:1,rotation:0,x:.5,y:.82});
    }
    base.audio = (Array.isArray(raw.audio) ? raw.audio : []).map(a => {
      const mediaId = String(a.mediaId || a.id || uid());
      const blob = mediaBlobs.get(mediaId) || null;
      const sourceIn = clamp(Number(a.sourceIn) || 0, 0, Math.max(0, Number(a.originalDuration) || Number(a.sourceOut) || Number(a.duration) || 0));
      const requestedDuration = Math.max(MIN_SHOT_SECONDS, Number(a.duration) || MIN_SHOT_SECONDS);
      const originalDuration = Math.max(sourceIn + requestedDuration, Number(a.originalDuration) || 0, Number(a.sourceOut) || 0);
      const sourceOut = clamp(Number(a.sourceOut) || sourceIn + requestedDuration, sourceIn + MIN_SHOT_SECONDS, originalDuration);
      return {
        id:String(a.id || uid()), mediaId, track:clamp(Number(a.track)||0,0,MAX_AUDIO_TRACKS-1),
        start:Math.max(0,Number(a.start)||0), duration:sourceOut-sourceIn, sourceIn, sourceOut, originalDuration,
        name:String(a.name||'Audio'), volume:clamp(Number.isFinite(Number(a.volume))?Number(a.volume):1,0,2), type:String(a.type||blob?.type||'audio/mpeg'),
        blob, url:blob ? URL.createObjectURL(blob) : null, needsRelink:!blob,
        ...(typeof a.linkGroupId==='string'&&a.linkGroupId?{linkGroupId:a.linkGroupId}:{}),
      };
    });
    const normalizedLinks=normalizeTimelineLinks([...base.clips,...base.audio]),linkedById=new Map(normalizedLinks.map(item=>[item.id,item]));
    base.clips=base.clips.map(item=>linkedById.get(item.id)||item);base.audio=base.audio.map(item=>linkedById.get(item.id)||item);
    base.videoTracks=clamp(Math.max(base.videoTracks,1+Math.max(-1,...base.clips.map(c=>c.track))),1,MAX_VIDEO_TRACKS);
    base.audioTracks=clamp(Math.max(base.audioTracks,1+Math.max(-1,...base.audio.map(c=>c.track))),0,MAX_AUDIO_TRACKS);
    base.videoTrackHeights=normalizedTrackHeights(raw.videoTrackHeights,base.videoTracks);base.videoTrackEnabled=normalizedTrackEnabled(raw.videoTrackEnabled,base.videoTracks);base.audioTrackHeights=normalizedTrackHeights(raw.audioTrackHeights,base.audioTracks);
    if(Number.isFinite(base.sequenceDuration))base.sequenceDuration=Math.max(base.sequenceDuration,contentDuration(base));
    return base;
  }

  function addItems(items, { append = true } = {}) {
    const list = (items || []).filter(it => (it.kind || 'image') === 'image');
    if (!list.length) { notify('Select one or more images on the board first'); return false; }
    let cursor = append ? Math.max(0, ...project.clips.filter(c => c.track === 0).map(c => c.start + c.duration)) : 0;
    const addedIds=[];
    for (const item of list) {
      const shotDuration=durationWithinSequence(cursor,DEFAULT_SHOT_SECONDS,DEFAULT_SHOT_SECONDS);if(!shotDuration)break;
      const clip={ id:uid(), itemId:item.id, mediaKind:'image', mediaId:null, track:0, start:cursor, duration:shotDuration, name:item.name || `Shot ${project.clips.length + 1}`, enabled:true, framing:{fit:'contain',scale:1,x:0,y:0}, strokes:[] };
      project.clips.push(clip);addedIds.push(clip.id);
      cursor += shotDuration;
    }
    if(!addedIds.length){notify('The fixed sequence has no room for another shot');return false;}
    if(addedIds.length<list.length)notify(`Added ${addedIds.length}; the fixed sequence is now full`);
    setTimelineSelection(addedIds,addedIds[0]);
    project.playhead = project.clips.find(c => c.id === selectedClipId)?.start || project.playhead;
    markDirty();
    renderAll();
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
    const targetTrack=clamp(Number(track)||0,0,MAX_VIDEO_TRACKS-1);activeVideoTrack=targetTrack;let cursor=Math.max(0,Number(start)||0),added=0;
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

  async function thumbUrl(clip) {
    const key=clip.mediaId||clip.itemId;
    if (thumbUrls.has(key)) return thumbUrls.get(key);
    const image = isVideoClip(clip)?null:getImage(clip.itemId);
    const source = isVideoClip(clip)?await videoSourceAt(clip,clip.start,true):(image?.proxy || await getBitmap(clip.itemId, { priority:'display' }));
    if (!source) return '';
    const c = document.createElement('canvas'); c.width=120; c.height=68;
    const g=c.getContext('2d'); g.fillStyle='#111'; g.fillRect(0,0,120,68);
    const sw=source.videoWidth||source.naturalWidth||source.width,sh=source.videoHeight||source.naturalHeight||source.height;if(!sw||!sh)return '';
    const k=Math.max(120/sw,68/sh); const w=sw*k,h=sh*k;
    g.drawImage(source,(120-w)/2,(68-h)/2,w,h);
    const url=c.toDataURL('image/jpeg',.7); c.width=c.height=0;
    thumbUrls.set(key,url); return url;
  }

  function renderTimeline() {
    clearRazorGuide();
    ensureTrackHeightCounts();
    syncActiveTrackTargets();
    const fixed=fixedSequenceEnd(),total=fixed??Math.max(10,Math.ceil(contentDuration()+3));
    const zoom=$('#anZoom');zoom.value=String(clamp(Number(project.timelineZoom)||90,Number(zoom.min)||.1,Number(zoom.max)||320));
    const px = Number(zoom.value) || 90;
    const laneWidth = Math.max(900,total*px),tickStep=timelineRulerStep(total,px),tickCount=Math.floor(total/tickStep+1e-8);
    grid.style.setProperty('--an-second-px',`${px}px`);
    grid.style.width=`${124+laneWidth}px`;
    let html='<div class="an-playhead"></div><div class="an-snap-guide"></div>';
    if(hasSequenceRange())html+=`<div class="an-sequence-range" style="--an-in-x:${project.inPoint*px}px;--an-range-w:${(project.outPoint-project.inPoint)*px}px"></div>`;
    if(Number.isFinite(project.inPoint))html+=`<div class="an-sequence-marker in" data-sequence-marker="in" role="separator" aria-label="Sequence In point" aria-orientation="vertical" tabindex="0" style="--an-marker-x:${project.inPoint*px}px" title="Drag sequence In"></div>`;
    if(Number.isFinite(project.outPoint))html+=`<div class="an-sequence-marker out" data-sequence-marker="out" role="separator" aria-label="Sequence Out point" aria-orientation="vertical" tabindex="0" style="--an-marker-x:${project.outPoint*px}px" title="Drag sequence Out"></div>`;
    const timeMode=project.timelineDisplay==='frames'?'FRAMES':'TIMECODE';
    html+=`<div class="an-ruler-row"><div class="an-track-label"><button class="an-time-mode" data-time-display title="Toggle timeline between timecode and frames">${timeMode}</button></div><div class="an-ruler">`;
    for(let index=0;index<=tickCount;index++){const s=index*tickStep,label=project.timelineDisplay==='frames'?`F ${Math.round(s*project.fps)}`:timecode(s,project.fps);html+=`<span class="an-tick" style="left:${s*px}px">${label}</span>`;}
    if(total-tickCount*tickStep>MIN_SHOT_SECONDS){const label=project.timelineDisplay==='frames'?`F ${Math.round(total*project.fps)}`:timecode(total,project.fps);html+=`<span class="an-tick" style="left:${total*px}px">${label}</span>`;}
    html+='</div></div>';
    if(project.texts.length){
      html+=`<div class="an-track-row"><div class="an-track-label"><b>T1</b><span>TEXT</span></div><div class="an-track-lane" data-kind="text" data-track="0" style="width:${laneWidth}px">`;
      for(const text of project.texts)html+=clipMarkup(text,px,'text');
      html+='</div></div>';
    }
    for(let track=0;track<project.videoTracks;track++){
      const height=trackHeight('video',track),rowClass=height<34?' compact':'';
      const grip=`<button class="an-track-grip" data-track-move="video" data-track="${track}" title="Drag to reorder V${track+1}" aria-label="Drag to reorder video track V${track+1}"><svg viewBox="0 0 12 16"><circle cx="3" cy="3" r="1.2"/><circle cx="9" cy="3" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="9" cy="8" r="1.2"/><circle cx="3" cy="13" r="1.2"/><circle cx="9" cy="13" r="1.2"/></svg></button>`;
      const target=`<button class="an-track-target ${track===activeVideoTrack?'on':''}" data-target-track="video" data-track="${track}" title="Paste to V${track+1}" aria-label="Target video track V${track+1}" aria-pressed="${String(track===activeVideoTrack)}">V${track+1}</button>`;
      const remove=project.videoTracks>1?`<button class="an-track-remove" data-remove-track="video" data-track="${track}" title="Remove empty V${track+1}" aria-label="Remove video track V${track+1}"><svg viewBox="0 0 12 12"><path d="m2 2 8 8M10 2 2 10"/></svg></button>`:'';
      const trackEnabled=isVideoTrackEnabled(track),visibility=`<button class="an-track-visibility ${trackEnabled?'':'off'}" data-toggle-track-visibility="${track}" title="${trackEnabled?'Disable':'Enable'} video track V${track+1}" aria-label="${trackEnabled?'Disable':'Enable'} video track V${track+1}" aria-pressed="${String(!trackEnabled)}">${visibilityIcon(trackEnabled)}</button>`;
      html+=`<div class="an-track-row${rowClass}${trackEnabled?'':' track-disabled'}" data-track-kind="video" data-track-index="${track}" style="--an-track-height:${height}px"><div class="an-track-label">${grip}${target}<span>VIDEO</span>${visibility}${remove}</div><div class="an-track-lane" data-kind="video" data-track="${track}" style="width:${laneWidth}px">`;
      for(const gap of timelineTrackGaps(project.clips,track,{minDuration:1/project.fps-1e-8}))html+=gapMarkup(gap,px,'video');
      for(const clip of project.clips.filter(c=>c.track===track)) html+=clipMarkup(clip,px,'video');
      html+=`</div><button class="an-track-resize" data-track-resize="video" data-track="${track}" role="separator" aria-orientation="horizontal" aria-label="Resize video track V${track+1}" title="Drag to resize V${track+1} · double-click to reset"></button></div>`;
    }
    if(project.videoTracks<MAX_VIDEO_TRACKS) html+=`<button class="an-track-add" data-add-track="video">+ Add video track <span>(${project.videoTracks}/${MAX_VIDEO_TRACKS})</span></button>`;
    for(let track=0;track<project.audioTracks;track++){
      const height=trackHeight('audio',track),rowClass=height<34?' compact':'';
      const grip=`<button class="an-track-grip" data-track-move="audio" data-track="${track}" title="Drag to reorder A${track+1}" aria-label="Drag to reorder audio track A${track+1}"><svg viewBox="0 0 12 16"><circle cx="3" cy="3" r="1.2"/><circle cx="9" cy="3" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="9" cy="8" r="1.2"/><circle cx="3" cy="13" r="1.2"/><circle cx="9" cy="13" r="1.2"/></svg></button>`;
      const target=`<button class="an-track-target ${track===activeAudioTrack?'on':''}" data-target-track="audio" data-track="${track}" title="Paste to A${track+1}" aria-label="Target audio track A${track+1}" aria-pressed="${String(track===activeAudioTrack)}">A${track+1}</button>`;
      const remove=`<button class="an-track-remove" data-remove-track="audio" data-track="${track}" title="Remove empty A${track+1}" aria-label="Remove audio track A${track+1}"><svg viewBox="0 0 12 12"><path d="m2 2 8 8M10 2 2 10"/></svg></button>`;
      html+=`<div class="an-track-row${rowClass}" data-track-kind="audio" data-track-index="${track}" style="--an-track-height:${height}px"><div class="an-track-label">${grip}${target}<span>AUDIO</span>${remove}</div><div class="an-track-lane" data-kind="audio" data-track="${track}" style="width:${laneWidth}px">`;
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

  function clipMarkup(clip,px,kind){
    const left=clip.start*px,width=Math.max(16,clip.duration*px);
    const selected=selectedTimelineIds.has(clip.id),primary=clip.id===primarySelectionId();
    const linkedPeer=!!clip.linkGroupId&&timelineMediaItems().some(item=>item.linkGroupId===clip.linkGroupId&&selectedTimelineIds.has(item.id));
    const visual=kind==='audio'?`<canvas class="an-wave" data-wave="${esc(clip.id)}"></canvas>`:kind==='text'?'':`<img data-thumb="${esc(clip.id)}" alt="">`;
    const linkBadge=clip.linkGroupId?'<span class="an-link-badge" title="Linked"><svg viewBox="0 0 16 16"><path d="m6.4 9.6 3.2-3.2M5 11l-1 1a2.1 2.1 0 0 1-3-3l2-2a2.1 2.1 0 0 1 3 0M11 5l1-1a2.1 2.1 0 0 1 3 3l-2 2a2.1 2.1 0 0 1-3 0"/></svg></span>':'';
    const label=kind==='text'?clip.content:clip.name;
    const disabled=kind==='video'&&!isVisualClipEnabled(clip);
    return `<div class="an-clip ${kind==='audio'?'an-audio':kind==='text'?'an-text-clip':isVideoClip(clip)?'an-video':''} ${disabled?'clip-disabled':''} ${selected?'on':''} ${primary?'primary':''} ${linkedPeer?'linked-peer':''}" data-clip="${esc(clip.id)}" data-kind="${kind}" style="left:${left}px;width:${width}px"><i class="an-trim an-trim-left" data-trim="left"></i>${visual}${linkBadge}<span class="an-clip-name">${esc(label)}</span><span class="an-clip-dur">${clipDurationLabel(clip)}</span><i class="an-trim" data-trim="right"></i></div>`;
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
      const h=Math.max(1,peak*(canvas.height-6));g.fillRect(x,(canvas.height-h)/2,1,h);
    }
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
    const scale=clamp(Number(text.scale)||1,.25,4),size=clamp(Number(text.size)||42,8,300)*scale*(w/1280);
    const lines=String(text.content??'').split(/\r?\n/).slice(0,12),lineH=size*1.18,pad=14*(w/1280)*scale;
    targetCtx.save();targetCtx.font=`600 ${size}px "Segoe UI",sans-serif`;
    const maxWidth=Math.max(...lines.map(line=>targetCtx.measureText(line||' ').width));targetCtx.restore();
    const boxH=lineH*Math.max(1,lines.length);
    return {scale,size,lines,lineH,maxWidth,boxH,pad,cx:clamp(finiteOr(text.x,.5),0,1)*w,cy:clamp(finiteOr(text.y,.82),0,1)*h,rotation:clamp(finiteOr(text.rotation,0),-180,180)*Math.PI/180,halfW:maxWidth/2+pad*1.3,halfH:boxH/2+pad};
  }

  function textUiMetrics(layout,w){
    const rect=canvas.getBoundingClientRect(),uiScale=w/Math.max(1,rect.width);
    return {handle:8*uiScale,hit:12*uiScale,rotateOffset:30*uiScale,anchor:6*uiScale};
  }

  function drawTextOverlay(targetCtx,text,w,h,selected=false){
    const layout=textLayout(targetCtx,text,w,h),{size,lines,lineH,maxWidth,boxH,pad,cx,cy,rotation,halfW,halfH}=layout;
    targetCtx.save();targetCtx.translate(cx,cy);targetCtx.rotate(rotation);
    targetCtx.font=`600 ${size}px "Segoe UI",sans-serif`;targetCtx.textAlign='center';targetCtx.textBaseline='middle';
    targetCtx.fillStyle='rgba(0,0,0,.58)';targetCtx.fillRect(-maxWidth/2-pad,-boxH/2-pad*.65,maxWidth+pad*2,boxH+pad*1.3);
    targetCtx.fillStyle=text.color||'#fff';lines.forEach((line,index)=>targetCtx.fillText(line,0,(index-(lines.length-1)/2)*lineH));
    if(selected){
      const {handle,rotateOffset,anchor}=textUiMetrics(layout,w);
      targetCtx.strokeStyle='#69aaff';targetCtx.lineWidth=Math.max(1,2*(w/1280));targetCtx.setLineDash([7*(w/1280),5*(w/1280)]);targetCtx.strokeRect(-halfW,-halfH,halfW*2,halfH*2);targetCtx.setLineDash([]);
      targetCtx.beginPath();targetCtx.moveTo(0,-halfH);targetCtx.lineTo(0,-halfH-rotateOffset);targetCtx.stroke();
      targetCtx.fillStyle='#0f1723';targetCtx.strokeStyle='#8bc1ff';
      for(const [x,y] of [[-halfW,-halfH],[halfW,-halfH],[-halfW,halfH],[halfW,halfH]]){targetCtx.beginPath();targetCtx.rect(x-handle/2,y-handle/2,handle,handle);targetCtx.fill();targetCtx.stroke();}
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
      const layout=textLayout(ctx,text,canvas.width,canvas.height),local=textLocalPoint(layout,point),{hit,rotateOffset}=textUiMetrics(layout,canvas.width);
      if(text.id===selectedTextId){
        if(Math.hypot(local.x,local.y+layout.halfH+rotateOffset)<=hit)return {text,layout,point,mode:'rotate'};
        for(const corner of [[-layout.halfW,-layout.halfH],[layout.halfW,-layout.halfH],[-layout.halfW,layout.halfH],[layout.halfW,layout.halfH]])if(Math.hypot(local.x-corner[0],local.y-corner[1])<=hit)return {text,layout,point,mode:'scale'};
      }
      if(Math.abs(local.x)<=layout.halfW&&Math.abs(local.y)<=layout.halfH)return {text,layout,point,mode:'move'};
    }
    return null;
  }

  function positionInlineTextEditor(){
    const text=project.texts.find(item=>item.id===inlineTextId);if(!text||!inlineTextEditor.classList.contains('open'))return;
    const layout=textLayout(ctx,text,canvas.width,canvas.height),rect=canvas.getBoundingClientRect(),width=clamp(layout.halfW*2*rect.width/canvas.width+28,120,Math.max(120,rect.width*.9)),height=clamp(layout.halfH*2*rect.height/canvas.height+18,42,Math.max(42,rect.height*.72));
    inlineTextEditor.style.left=`${text.x*100}%`;inlineTextEditor.style.top=`${text.y*100}%`;inlineTextEditor.style.width=`${width}px`;inlineTextEditor.style.height=`${height}px`;inlineTextEditor.style.fontSize=`${Math.max(14,layout.size*rect.height/canvas.height)}px`;inlineTextEditor.style.color=text.color||'#fff';inlineTextEditor.style.transform=`translate(-50%,-50%) rotate(${clamp(finiteOr(text.rotation,0),-180,180)}deg)`;
  }

  function beginInlineTextEdit(text){
    inlineTextId=text.id;inlineTextOriginal=text.content;inlineTextEditor.value=text.content;inlineTextEditor.classList.add('open');positionInlineTextEditor();inlineTextEditor.focus();inlineTextEditor.select();
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
      const framing=clip.framing||{fit:'contain',scale:1,x:0,y:0};
      const sw=source.videoWidth||source.naturalWidth||source.width,sh=source.videoHeight||source.naturalHeight||source.height;if(!sw||!sh)continue;
      const baseK=framing.fit==='cover'?Math.max(w/sw,h/sh):Math.min(w/sw,h/sh);
      const k=baseK*clamp(Number(framing.scale)||1,.25,4); const dw=sw*k,dh=sh*k;
      const cx=w/2+clamp(Number(framing.x)||0,-1,1)*w/2;
      const cy=h/2+clamp(Number(framing.y)||0,-1,1)*h/2;
      targetCtx.drawImage(source,cx-dw/2,cy-dh/2,dw,dh);
      for(const stroke of clip.strokes||[]){
        if(!stroke.points?.length) continue;
        targetCtx.beginPath(); targetCtx.strokeStyle=stroke.color||'#ff5c5c'; targetCtx.lineWidth=(stroke.width||6)*(w/1280); targetCtx.lineCap='round'; targetCtx.lineJoin='round';
        stroke.points.forEach((p,i)=>i?targetCtx.lineTo(p.x*w,p.y*h):targetCtx.moveTo(p.x*w,p.y*h)); targetCtx.stroke();
      }
    }
    for(const text of activeTexts)drawTextOverlay(targetCtx,text,w,h,mainViewer&&text.id===selectedTextId);
    if(burnTc){
      const fs=Math.max(14,22*(w/1280)); targetCtx.font=`600 ${fs}px ui-monospace,Consolas,monospace`; targetCtx.textAlign='left'; targetCtx.textBaseline='top';
      const label=counterLabel(t),pad=10*(w/1280); const tw=targetCtx.measureText(label).width;
      targetCtx.fillStyle='rgba(0,0,0,.62)'; targetCtx.fillRect(pad,pad,tw+pad*1.4,fs+pad);
      targetCtx.fillStyle='#fff'; targetCtx.fillText(label,pad*1.7,pad*1.45);
    }
    targetCtx.restore();
    if(!mainViewer)return;
    $('#anEmpty')?.classList.toggle('hide',active.length>0||activeTexts.length>0);
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

  function syncInspector(){
    const clip=selectedClip();
    const text=selectedText();
    const visuals=selectedVisualClips(),audios=selectedAudioClips(),durationItems=selectedDurationItems(),frameDuration=uniformValue(durationItems,item=>Math.max(1,Math.round(item.duration*project.fps)),0);
    for(const selector of ['#anDuration','#anAudioDuration']){const input=$(selector);input.value=frameDuration===null?'':String(Number((frameDuration/project.fps).toFixed(3)));input.disabled=!durationItems.length;}
    for(const selector of ['#anDurationFrames','#anAudioDurationFrames']){const input=$(selector);input.value=frameDuration===null?'':String(frameDuration??'');input.disabled=!durationItems.length;}
    $('#anClipSelectionTitle').textContent=visuals.length?`${visuals.length} visual clip${visuals.length===1?'':'s'} selected${audios.length?` · ${audios.length} audio`:''}`:'No visual clips selected';
    $('#anAudioSelectionTitle').textContent=audios.length?`${audios.length} audio clip${audios.length===1?'':'s'} selected${visuals.length?` · ${visuals.length} visual`:''}`:'No audio clips selected';
    const framing=visuals[0]?.framing||{fit:'contain',scale:1,x:0,y:0},scalePercent=uniformValue(visuals,item=>Math.round((item.framing?.scale||1)*100),0),allContain=visuals.length&&visuals.every(item=>(item.framing?.fit||'contain')==='contain'),allCover=visuals.length&&visuals.every(item=>item.framing?.fit==='cover');
    $('#anFrameFit').classList.toggle('on',!!allContain);$('#anFrameFill').classList.toggle('on',!!allCover);
    for(const selector of ['#anFrameFit','#anFrameFill','#anFrameReset'])$(selector).disabled=!visuals.length;
    $('#anFrameScale').value=String(scalePercent??Math.round(framing.scale*100));
    $('#anFrameScale').disabled=!visuals.length;
    $('#anFrameScaleVal').value=scalePercent===null?'Mixed':`${scalePercent}%`;
    $('#anFrameScaleVal').textContent=scalePercent===null?'Mixed':`${scalePercent}%`;
    const allDisabled=visuals.length&&visuals.every(clip=>!isVisualClipEnabled(clip)),visibilityButton=$('#anToggleClipVisibility');visibilityButton.disabled=!visuals.length;visibilityButton.classList.toggle('on',!!allDisabled);visibilityButton.textContent=allDisabled?'Enable selected':'Disable selected';visibilityButton.setAttribute('aria-pressed',String(!!allDisabled));
    $('#anSplit').disabled=!primarySelectionId();$('#anDeleteClip').disabled=!selectedTimelineIds.size;
    if(text){
      $('#anText').value=text.content;$('#anTextSize').value=String(text.size);$('#anTextColor').value=text.color;
      $('#anTextScale').value=String(Math.round(text.scale*100));$('#anTextScaleVal').value=`${Math.round(text.scale*100)}%`;$('#anTextScaleVal').textContent=`${Math.round(text.scale*100)}%`;
      $('#anTextRotation').value=String(text.rotation);$('#anTextDuration').value=String(Number(text.duration.toFixed(3)));$('#anTextX').value=String(Math.round(text.x*100));$('#anTextY').value=String(Math.round(text.y*100));
    }
    $('#anAddText').textContent=text?'Update text layer':'Add text layer';$('#anClearText').disabled=!text;
    const audioPercent=uniformValue(audios,item=>Math.round((item.volume??1)*100),0),audioFallback=Math.round((audios[0]?.volume??1)*100),allMuted=audios.length&&audios.every(item=>item.volume===0);$('#anAudioVolume').value=String(audioPercent??audioFallback);$('#anAudioVolume').disabled=!audios.length;$('#anAudioVolumeVal').value=audioPercent===null?'Mixed':`${audioPercent}%`;$('#anAudioVolumeVal').textContent=audioPercent===null?'Mixed':`${audioPercent}%`;
    $('#anAudioMute').disabled=!audios.length;$('#anAudioMute').classList.toggle('on',!!allMuted);$('#anAudioMute').textContent=allMuted?'Unmute selected':'Mute selected';$('#anAudioSplit').disabled=!primarySelectionId();$('#anAudioDelete').disabled=!selectedTimelineIds.size;
    $('#anDrawToggle').classList.toggle('on',drawMode);
    $('#anDrawToggle').textContent=drawMode?'Stop drawing':'Start drawing';
    $('#anTcToggle').classList.toggle('on',project.timecode);
    const counterName=project.counterMode==='frames'?'frame counter':project.counterMode==='seconds'?'seconds counter':'timecode';
    $('#anTcToggle').textContent=project.timecode?`Hide ${counterName} in picture`:`Show ${counterName} in picture`;
    $('#anCounterMode').value=project.counterMode;
    $('#anProjectFps').value=String(project.fps);
    $('#anFooterAspect').value=project.aspect;
    $('#anFooterQuality').value=project.previewQuality;
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
    const px=Number($('#anZoom').value)||90,isOutside=time=>{const x=124+time*px-scroll.scrollLeft;return x<124||x>scroll.clientWidth;};
    grid.querySelector('.an-playhead')?.classList.toggle('out-of-view',isOutside(project.playhead));
    for(const marker of grid.querySelectorAll('[data-sequence-marker]')){const time=marker.dataset.sequenceMarker==='in'?project.inPoint:project.outPoint;marker.classList.toggle('out-of-view',!Number.isFinite(time)||isOutside(time));}
  }

  function applyTimelineZoom(nextZoom){
    const slider=$('#anZoom'),oldPx=Number(project.timelineZoom)||Number(slider.value)||90,next=clamp(Number(nextZoom)||oldPx,Number(slider.min)||.1,Number(slider.max)||320),rect=scroll.getBoundingClientRect(),playheadX=124+project.playhead*oldPx-scroll.scrollLeft,anchorX=playheadX>=124&&playheadX<=rect.width?playheadX:Math.max(124,rect.width/2);
    project.timelineZoom=next;slider.value=String(next);renderTimeline();scroll.scrollLeft=Math.max(0,project.playhead*next+124-anchorX);syncPlayheadVisibility();
  }

  function applyPreviewQuality(){
    const shortEdge=project.previewQuality==='full'?1080:project.previewQuality==='half'?540:270;
    const {width,height}=sequenceDimensions(shortEdge,project.aspect);
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    const [rw,rh]=ASPECT_RATIOS[project.aspect]||ASPECT_RATIOS['16:9'];
    canvas.parentElement.style.aspectRatio=`${rw}/${rh}`;
    $('#anFooterAspect').value=project.aspect;
    $('#anFooterQuality').value=project.previewQuality;
  }

  function applyTimelineHeight(){root.style.setProperty('--an-timeline-h',`${clamp(project.timelineHeight,180,Math.max(180,window.innerHeight-220))}px`);}

  function renderAll(){ applyTimelineHeight();applyPreviewQuality(); renderTimeline(); syncInspector(); renderTransport(); drawViewer(); }

  function setPlayhead(value){ project.playhead=clamp(value,0,duration()); renderTransport(); drawViewer(); }

  function scheduleScrubPreview(){
    scrubPreviewQueued=true;if(scrubPreviewRaf||scrubPreviewBusy)return;
    scrubPreviewRaf=requestAnimationFrame(async()=>{scrubPreviewRaf=0;if(!open){scrubPreviewQueued=false;return;}scrubPreviewQueued=false;scrubPreviewBusy=true;try{await drawViewer();}finally{scrubPreviewBusy=false;if(scrubPreviewQueued)scheduleScrubPreview();}});
  }

  function scrubTo(value){project.playhead=clamp(value,0,duration());renderTransport();scheduleScrubPreview();}

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

  function updateActiveAudioGain(clip){
    const value=clamp(Number.isFinite(Number(clip?.volume))?Number(clip.volume):1,0,2);
    for(const entry of audioPlayers)if(entry.clipId===clip?.id){if(entry.gain)entry.gain.gain.value=value;else entry.player.volume=Math.min(1,value);}
  }

  function startAudioPlayback(){
    stopAudioPlayback();
    for(const clip of project.audio){
      if(!clip.url||project.playhead>=clip.start+clip.duration)continue;
      const launch=()=>{
        if(!playing)return;
        const player=new Audio(clip.url),volume=clamp(Number.isFinite(Number(clip.volume))?Number(clip.volume):1,0,2),context=ensurePlaybackAudioContext();let source=null,gain=null;
        if(context){void context.resume().catch(()=>{});source=context.createMediaElementSource(player);gain=context.createGain();gain.gain.value=volume;source.connect(gain).connect(context.destination);}else player.volume=Math.min(1,volume);
        const offset=Math.max(0,project.playhead-clip.start),sourceIn=Number(clip.sourceIn)||0,sourceOut=Number(clip.sourceOut)||sourceIn+clip.duration;
        player.currentTime=sourceIn+offset;
        player.ontimeupdate=()=>{if(player.currentTime>=sourceOut-.005)player.pause();};
        player.play().catch(()=>{}); audioPlayers.push({player,source,gain,clipId:clip.id});
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
    project.playhead=clamp(next,0,duration());renderTransport();if(!clipsAt(next).some(isVideoClip))drawViewer();raf=requestAnimationFrame(tick);
  }

  function openEditor(items=[]){
    if(!open){try{onOpen();}catch(err){console.error('[animatics] board view capture failed',err);}}
    open=true; document.body.classList.add('animatics-open'); root.classList.add('open','panel-open'); root.setAttribute('aria-hidden','false');
    syncActiveTrackTargets();setActiveTool('select');
    if(items.length) addItems(items,{append:project.clips.length>0}); else renderAll();
    resizeViewer();
  }

  function closeEditor(){
    if(!open)return;
    if(audioTrimState)finishAudioTrimmer(false);if(inlineTextId)finishInlineTextEdit(false);flushDeferredHistory();open=false;setPlaying(false);
    cancelAnimationFrame(scrubPreviewRaf);scrubPreviewRaf=0;scrubPreviewQueued=false;viewerDrawToken++;
    drawMode=false;framingMode=false;framingDrag=null;textDrag=null;marqueeDrag=null;handPan=null;spaceHand=null;root.classList.remove('hand-panning');$('#anMarquee').classList.remove('show');if(dragging)clearTimelineDrag(true);document.body.classList.remove('animatics-open');root.classList.remove('open');root.setAttribute('aria-hidden','true');canvas.parentElement.classList.remove('framing');
    // Pausing alone leaves Chromium decoder buffers and GPU textures resident.
    // Keep the source Blob URLs/project intact, but recreate decoders and the
    // preview backing store next time Animatics opens.
    releaseVideoElements();releaseAudioPlaybackContext();canvas.width=1;canvas.height=1;
    try{onClose();}catch(err){console.error('[animatics] board return recovery failed',err);}
  }

  function resizeViewer(){
    const shell=canvas.parentElement,wrap=shell.parentElement;
    const availableW=wrap.clientWidth,availableH=Math.max(1,wrap.clientHeight-52);
    if(!availableW||!availableH)return;
    const [rw,rh]=ASPECT_RATIOS[project.aspect]||ASPECT_RATIOS['16:9'];
    const ratio=rw/rh; let w=availableW,h=w/ratio;
    if(h>availableH){h=availableH;w=h*ratio;}
    shell.style.width=`${Math.floor(w)}px`;shell.style.height=`${Math.floor(h)}px`;
    canvas.style.width='100%';canvas.style.height='100%';drawViewer();positionInlineTextEditor();
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

  function applySelectedDuration(requestedDuration){
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
    cleanupTimelineLinks();setTimelineSelection(selection,primary);markDirty();renderAll();
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
    if(entry.kind==='video'||entry.kind==='audio'){
      const source=[...project.clips.map(item=>({...item,__timelineKind:'video'})),...project.audio.map(item=>({...item,__timelineKind:'audio'}))],result=splitLinkedTimelineItems(source,entry.item.id,at,{minDuration:MIN_SHOT_SECONDS,makeId:uid,makeLinkId:uid});
      if(!result){notify('Move the playhead inside the selected layer');return false;}
      const stripKind=item=>{const {__timelineKind,...clean}=item;return clean;};project.clips=result.items.filter(item=>item.__timelineKind==='video').map(stripKind);project.audio=result.items.filter(item=>item.__timelineKind==='audio').map(stripKind);
      setTimelineSelection(result.rightIds,result.targetRightId);markDirty();renderAll();return true;
    }
    const pieces=splitTimelineItem(entry.item,at,{minDuration:MIN_SHOT_SECONDS,makeId:uid});if(!pieces){notify('Move the playhead inside the selected layer');return false;}
    if(pieces[1].strokes)pieces[1].strokes=structuredClone(pieces[1].strokes);
    const index=entry.collection.findIndex(item=>item.id===entry.item.id);entry.collection.splice(index,1,...pieces);setTimelineSelection([pieces[1].id],pieces[1].id);markDirty();renderAll();return true;
  }

  function addTextAtTime(start,{x=.5,y=.82}={}){
    start=Math.round(Math.max(0,start)*project.fps)/project.fps;const textDuration=durationWithinSequence(start,DEFAULT_SHOT_SECONDS,DEFAULT_SHOT_SECONDS);if(!textDuration){notify('The fixed sequence has no room for a text layer here');return null;}const text={id:uid(),track:0,start,duration:textDuration,content:'Text',size:42,color:'#ffffff',scale:1,rotation:0,x:clamp(x,0,1),y:clamp(y,0,1)};
    project.texts.push(text);project.playhead=text.start;setTimelineSelection([text.id],text.id);root.querySelector('[data-panel="text"]')?.click();markDirty();renderAll();requestAnimationFrame(()=>beginInlineTextEdit(text));
  }

  function razorTimelineEntry(entry,time){
    if(!entry)return false;setTimelineSelection([entry.item.id],entry.item.id);project.playhead=Math.round(Math.max(0,time)*project.fps)/project.fps;const didSplit=splitSelected(project.playhead);if(didSplit)notify(`Cut at ${timecode(project.playhead,project.fps)}`);return didSplit;
  }

  function setSequenceIn(){project.inPoint=project.playhead;if(Number.isFinite(project.outPoint)&&project.outPoint<=project.inPoint+MIN_SHOT_SECONDS)project.outPoint=null;markDirty();renderTimeline();notify(`In set to ${timecode(project.inPoint,project.fps)}`);}
  function setSequenceOut(){project.outPoint=project.playhead;if(Number.isFinite(project.inPoint)&&project.inPoint>=project.outPoint-MIN_SHOT_SECONDS)project.inPoint=null;markDirty();renderTimeline();notify(`Out set to ${timecode(project.outPoint,project.fps)}`);}
  function clearSequenceRange(){project.inPoint=null;project.outPoint=null;markDirty();renderTimeline();notify('Sequence range cleared');}

  function syncSequenceModeUi(){const fixed=$('#anSequenceMode').value==='fixed';$('#anSequenceDuration').disabled=!fixed;}

  function openSequenceSettings(){
    const used=contentDuration(),suggested=fixedSequenceEnd()??Math.max(180,Math.ceil(used));
    $('#anSequenceMode').value=fixedSequenceEnd()===null?'auto':'fixed';$('#anTimelineDisplay').value=project.timelineDisplay;$('#anSequenceDuration').value=timecode(suggested,project.fps);$('#anSequenceMinimum').textContent=used>0?`Content ends ${timecode(used,project.fps)}`:'No content yet';syncSequenceModeUi();$('#anSequenceModal').classList.add('open');
  }

  function applySequenceSettings(){
    const fixed=$('#anSequenceMode').value==='fixed',used=contentDuration();let next=null;
    if(fixed){next=parseSequenceTimecode($('#anSequenceDuration').value,project.fps);if(!Number.isFinite(next)||next<MIN_SHOT_SECONDS||next>MAX_SEQUENCE_SECONDS){notify('Enter a duration from one frame up to 24 hours');return;}next=Math.round(next*project.fps)/project.fps;if(next+1e-8<used){notify(`Sequence must be at least ${timecode(used,project.fps)} to preserve existing layers`);return;}}
    project.sequenceDuration=next;project.timelineDisplay=$('#anTimelineDisplay').value==='frames'?'frames':'timecode';if(next!==null&&project.timelineZoom*next>SAFE_INITIAL_TIMELINE_PIXELS)project.timelineZoom=clamp(SAFE_INITIAL_TIMELINE_PIXELS/next,.1,320);project.playhead=clamp(project.playhead,0,duration());if(Number.isFinite(project.inPoint)&&project.inPoint>duration())project.inPoint=null;if(Number.isFinite(project.outPoint)&&project.outPoint>duration())project.outPoint=duration();if(Number.isFinite(project.inPoint)&&Number.isFinite(project.outPoint)&&project.outPoint<=project.inPoint+MIN_SHOT_SECONDS)project.outPoint=null;markDirty();renderAll();$('#anSequenceModal').classList.remove('open');notify(next===null?'Sequence follows content':`Sequence fixed at ${timecode(next,project.fps)}`);
  }

  function toggleTimelineDisplay(){project.timelineDisplay=project.timelineDisplay==='frames'?'timecode':'frames';markDirty();renderTimeline();}

  function removeTimelineTrack(kind,track){
    const video=kind==='video',collection=video?project.clips:project.audio,count=video?project.videoTracks:project.audioTracks,label=`${video?'V':'A'}${track+1}`;
    if(!Number.isInteger(track)||track<0||track>=count)return false;
    if(video&&count<=1){notify('V1 is the required primary video track');return false;}
    const occupied=collection.filter(item=>item.track===track);if(occupied.length){notify(`${label} contains ${occupied.length} layer${occupied.length===1?'':'s'} — move or delete them first`);return false;}
    for(const item of collection)if(item.track>track)item.track--;
    ensureTrackHeightCounts();trackHeights(kind).splice(track,1);if(video){project.videoTrackEnabled.splice(track,1);project.videoTracks--;activeVideoTrack=activeVideoTrack===track?Math.min(track,project.videoTracks-1):activeVideoTrack>track?activeVideoTrack-1:activeVideoTrack;}else{project.audioTracks--;activeAudioTrack=activeAudioTrack===track?Math.min(track,Math.max(0,project.audioTracks-1)):activeAudioTrack>track?activeAudioTrack-1:activeAudioTrack;}markDirty();renderTimeline();notify(`${label} removed`);return true;
  }

  function upsertTextLayer(){
    const content=$('#anText').value.trim();if(!content){notify('Enter some text first');return;}
    let text=selectedText();
    if(!text){const clip=selectedClip(),start=clip?.start??project.playhead,requested=Number($('#anTextDuration').value)||clip?.duration||DEFAULT_SHOT_SECONDS,textDuration=durationWithinSequence(start,requested,600);if(!textDuration){notify('The fixed sequence has no room for a text layer here');return;}text={id:uid(),track:0,start,duration:textDuration,content,size:42,color:'#ffffff',scale:1,rotation:0,x:.5,y:.82};project.texts.push(text);setTimelineSelection([text.id],text.id);}
    text.content=content;text.size=clamp(Number($('#anTextSize').value)||42,8,300);text.color=$('#anTextColor').value;text.scale=clamp(Number($('#anTextScale').value)/100,.25,4);text.rotation=clamp(Number($('#anTextRotation').value)||0,-180,180);text.duration=durationWithinSequence(text.start,Number($('#anTextDuration').value)||DEFAULT_SHOT_SECONDS,600)||text.duration;text.x=clamp(Number($('#anTextX').value)/100,0,1);text.y=clamp(Number($('#anTextY').value)/100,0,1);
    project.playhead=clamp(project.playhead,text.start,text.start+text.duration-MIN_SHOT_SECONDS);markDirty();renderAll();root.querySelector('[data-panel="text"]')?.click();
  }

  function updateSelectedTextFromControls(){
    const text=selectedText();if(!text)return;
    text.size=clamp(Number($('#anTextSize').value)||42,8,300);text.color=$('#anTextColor').value;text.scale=clamp(Number($('#anTextScale').value)/100,.25,4);text.rotation=clamp(Number($('#anTextRotation').value)||0,-180,180);text.duration=durationWithinSequence(text.start,Number($('#anTextDuration').value)||DEFAULT_SHOT_SECONDS,600)||text.duration;text.x=clamp(Number($('#anTextX').value)/100,0,1);text.y=clamp(Number($('#anTextY').value)/100,0,1);
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

  async function addAudioFiles(files){
    const remaining=MAX_AUDIO_TRACKS-project.audioTracks; const list=[...files].slice(0,remaining);
    let added=0;
    for(const file of list){
      const trimmed=await openAudioTrimmer(file);if(!trimmed)continue;
      const requested=trimmed.sourceOut-trimmed.sourceIn,duration=durationWithinSequence(project.playhead,requested,requested);if(!duration){URL.revokeObjectURL(trimmed.url);notify('The fixed sequence has no room for audio here');continue;}const track=project.audioTracks++,clip={id:uid(),mediaId:uid(),track,start:project.playhead,duration,sourceIn:trimmed.sourceIn,sourceOut:trimmed.sourceIn+duration,originalDuration:trimmed.duration,name:file.name,blob:file,url:trimmed.url,volume:1,type:file.type||'audio/mpeg',needsRelink:false};activeAudioTrack=track;ensureTrackHeightCounts();
      project.audio.push(clip);if(trimmed.waveform)audioWaveformCache.set(clip.mediaId,trimmed.waveform);setTimelineSelection([clip.id],clip.id);
      added++;
    }
    if(added){markDirty();renderAll();notify(`Added ${added} audio track${added===1?'':'s'}`);}
  }

  function pointerTime(event,lane){ const r=lane.getBoundingClientRect(); const px=Number($('#anZoom').value)||90; return Math.max(0,(event.clientX-r.left)/px); }

  function clearRazorGuide(){
    razorHoverClip?.classList.remove('razor-hover');razorHoverClip=null;$('#anRazorGuide')?.classList.remove('show');
  }

  function razorTargetAt(event){
    if(activeTool!=='razor')return null;
    const clipEl=event.target.closest?.('.an-clip'),lane=clipEl?.closest('.an-track-lane');if(!clipEl||!lane)return;
    const entry=entryById(clipEl.dataset.clip);if(!entry)return;
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
    for(const el of state.sourceEls)el.classList.remove('dragging-source');for(const ghost of state.ghosts)ghost.remove();state.hoverLane?.classList.remove('an-lane-hover');
    grid.querySelector('.an-snap-guide')?.classList.remove('show');dragging=null;
  }

  function panelForKind(kind){root.querySelector(`[data-panel="${kind==='video'?'clip':kind}"]`)?.click();}

  function showSnapGuide(time){
    const guide=grid.querySelector('.an-snap-guide');if(!guide)return;
    guide.classList.toggle('show',Number.isFinite(time));if(Number.isFinite(time))guide.style.transform=`translateX(${time*(Number($('#anZoom').value)||90)}px)`;
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
    if(e.clientX>scrollRect.right-24)scroll.scrollLeft+=16;else if(e.clientX<scrollRect.left+148)scroll.scrollLeft=Math.max(0,scroll.scrollLeft-16);
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
    const trackResizeHandle=e.target.closest('.an-track-resize');
    if(trackResizeHandle){const kind=trackResizeHandle.dataset.trackResize,track=Number(trackResizeHandle.dataset.track);trackResize={kind,track,startY:e.clientY,startHeight:trackHeight(kind,track),pointerId:e.pointerId};trackResizeHandle.classList.add('dragging');grid.setPointerCapture?.(e.pointerId);e.preventDefault();return;}
    const trackGrip=e.target.closest('.an-track-grip');
    if(trackGrip){const kind=trackGrip.dataset.trackMove,from=Number(trackGrip.dataset.track);trackReorder={kind,from,to:from,pointerId:e.pointerId};grid.setPointerCapture?.(e.pointerId);grid.querySelector(`.an-track-row[data-track-kind="${kind}"][data-track-index="${from}"]`)?.classList.add('reorder-source');e.preventDefault();return;}
    const sequenceMarker=e.target.closest('.an-sequence-marker');
    if(sequenceMarker){if(playing)setPlaying(false);sequenceMarkerDrag={kind:sequenceMarker.dataset.sequenceMarker,el:sequenceMarker,pointerId:e.pointerId};sequenceMarker.setPointerCapture?.(e.pointerId);e.preventDefault();return;}
    const gapEl=e.target.closest('.an-gap');const clipEl=e.target.closest('.an-clip'); const lane=e.target.closest('.an-track-lane');
    if(gapEl&&activeTool==='select'){
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
    selectedGap=null;
    if(activeTool==='razor'&&razorTarget){clearRazorGuide();razorTimelineEntry({item:clip,kind,collection},razorTarget.time);e.preventDefault();return;}
    if(activeTool==='text'){scrubTo(pointerTime(e,lane));e.preventDefault();return;}
    const trimEdge=e.target.dataset.trim||null,modifier=e.shiftKey||e.ctrlKey||e.metaKey;
    if(trimEdge)setTimelineSelection([clip.id],clip.id);else if(modifier)selectTimelineEntry(clip.id,{add:e.shiftKey,toggle:e.ctrlKey||e.metaKey});else if(!selectedTimelineIds.has(clip.id))setTimelineSelection([clip.id],clip.id);else syncPrimarySelection(clip.id);
    if(!selectedTimelineIds.has(clip.id)){renderTimeline();syncInspector();return;}
    panelForKind(kind);syncInspector();drawViewer();
    const movedIds=trimEdge?new Set([clip.id]):linkedTimelineIds(timelineMediaItems(),selectedTimelineIds),selectedEntries=trimEdge?[{item:clip,kind,collection}]:[...movedIds].map(entryById).filter(Boolean),sourceEls=[],ghosts=[];
    const originals=selectedEntries.map(entry=>({item:entry.item,kind:entry.kind,values:{start:entry.item.start,duration:entry.item.duration,track:entry.item.track,sourceIn:entry.item.sourceIn,sourceOut:entry.item.sourceOut}}));
    dragging={clip,kind,trimEdge,movedIds,startX:e.clientX,startY:e.clientY,startScrollLeft:scroll.scrollLeft,startTrack:Number(clip.track)||0,originals,sourceEls,ghosts,hoverLane:lane,moved:false};
    if(!trimEdge)for(const entry of selectedEntries){const el=grid.querySelector(`[data-clip="${CSS.escape(entry.item.id)}"]`);if(!el)continue;const rect=el.getBoundingClientRect(),ghost=el.cloneNode(true);ghost.classList.add('an-drag-ghost');ghost.classList.remove('dragging-source','on','primary');Object.assign(ghost.style,{left:`${rect.left}px`,top:`${rect.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});root.append(ghost);ghosts.push(ghost);sourceEls.push(el);el.classList.add('dragging-source');}
    lane?.classList.add('an-lane-hover');
    clipEl.setPointerCapture(e.pointerId); e.preventDefault();
  });
  grid.addEventListener('pointermove',e=>{
    if(handPan){if(spaceHand&&Math.hypot(e.clientX-handPan.startX,e.clientY-handPan.startY)>2)spaceHand.used=true;scroll.scrollLeft=handPan.startScrollLeft-(e.clientX-handPan.startX)*1.35;scroll.scrollTop=handPan.startScrollTop-(e.clientY-handPan.startY)*1.35;syncPlayheadVisibility();return;}
    if(trackResize){const height=clamp(trackResize.startHeight+e.clientY-trackResize.startY,MIN_TRACK_HEIGHT,MAX_TRACK_HEIGHT);setTrackHeight(trackResize.kind,trackResize.track,height);const row=grid.querySelector(`.an-track-row[data-track-kind="${trackResize.kind}"][data-track-index="${trackResize.track}"]`);if(row){row.style.setProperty('--an-track-height',`${height}px`);row.classList.toggle('compact',height<34);row.querySelector('.an-track-resize')?.classList.add('dragging');}return;}
    if(trackReorder){const hit=document.elementFromPoint(e.clientX,e.clientY)?.closest?.(`.an-track-row[data-track-kind="${trackReorder.kind}"]`);if(hit)trackReorder.to=Number(hit.dataset.trackIndex);for(const row of grid.querySelectorAll(`.an-track-row[data-track-kind="${trackReorder.kind}"]`)){const index=Number(row.dataset.trackIndex);row.classList.toggle('reorder-source',index===trackReorder.from);row.classList.toggle('reorder-target',index===trackReorder.to&&index!==trackReorder.from);}return;}
    if(activeTool==='razor'&&!sequenceMarkerDrag&&!scrubbing&&!marqueeDrag&&!dragging)updateRazorGuide(e);
    if(gapPress){if(Math.hypot(e.clientX-gapPress.startX,e.clientY-gapPress.startY)<=3)return;const state=gapPress;gapPress=null;beginMarquee(e,state.lane,state.bounds,grid,{x:state.startX,y:state.startY});updateMarquee(e);return;}
    if(sequenceMarkerDrag){setSequenceMarkerValue(sequenceMarkerDrag.kind,pointerTime(e,grid.querySelector('.an-ruler')));return;}
    if(scrubbing){scrubTo(pointerTime(e,scrubbing.target));return;}
    if(marqueeDrag){updateMarquee(e);return;}
    if(!dragging)return; const px=Number($('#anZoom').value)||90; const step=e.shiftKey?1/project.fps:.05;
    if(!dragging.moved&&Math.hypot(e.clientX-dragging.startX,e.clientY-dragging.startY)<2)return;dragging.moved=true;
    const scrollRect=scroll.getBoundingClientRect();if(e.clientX>scrollRect.right-24)scroll.scrollLeft+=16;else if(e.clientX<scrollRect.left+148)scroll.scrollLeft=Math.max(0,scroll.scrollLeft-16);
    let delta=Math.round((((e.clientX-dragging.startX)+(scroll.scrollLeft-dragging.startScrollLeft))/px)/step)*step;
    if(dragging.trimEdge==='right'){
      const original=dragging.originals[0],sourceBounded=dragging.kind==='audio'||isVideoClip(dragging.clip),sourceMax=sourceBounded?Math.max(MIN_SHOT_SECONDS,(dragging.clip.originalDuration||original.values.sourceOut)-original.values.sourceIn):600,maxDuration=Math.min(sourceMax,fixedSequenceEnd()===null?sourceMax:Math.max(MIN_SHOT_SECONDS,fixedSequenceEnd()-original.values.start));
      let end=original.values.start+clamp(original.values.duration+delta,MIN_SHOT_SECONDS,maxDuration);if(project.timelineSnap){const candidates=[0,fixedSequenceEnd(),project.playhead,project.inPoint,project.outPoint,...entryById(dragging.clip.id).collection.filter(c=>c.id!==dragging.clip.id&&c.track===dragging.clip.track).flatMap(c=>[c.start,c.start+c.duration])].filter(Number.isFinite);let best=null;for(const candidate of candidates)if(Math.abs(candidate-end)<=8/px&&(best===null||Math.abs(candidate-end)<Math.abs(best-end)))best=candidate;if(best!==null){end=best;showSnapGuide(best);}else showSnapGuide(null);}
      dragging.clip.duration=clamp(end-original.values.start,MIN_SHOT_SECONDS,maxDuration);if(sourceBounded)dragging.clip.sourceOut=original.values.sourceIn+dragging.clip.duration;
    }else if(dragging.trimEdge==='left'){
      const original=dragging.originals[0],sourceBounded=dragging.kind==='audio'||isVideoClip(dragging.clip),minDelta=sourceBounded?Math.max(-original.values.sourceIn,-original.values.start):-original.values.start;delta=clamp(delta,minDelta,original.values.duration-MIN_SHOT_SECONDS);
      let start=original.values.start+delta;if(project.timelineSnap){const candidates=[0,project.playhead,project.inPoint,project.outPoint,...entryById(dragging.clip.id).collection.filter(c=>c.id!==dragging.clip.id&&c.track===dragging.clip.track).flatMap(c=>[c.start,c.start+c.duration])].filter(Number.isFinite);let best=null;for(const candidate of candidates)if(Math.abs(candidate-start)<=8/px&&(best===null||Math.abs(candidate-start)<Math.abs(best-start)))best=candidate;if(best!==null){start=best;delta=start-original.values.start;showSnapGuide(best);}else showSnapGuide(null);}
      delta=clamp(start-original.values.start,minDelta,original.values.duration-MIN_SHOT_SECONDS);start=original.values.start+delta;dragging.clip.start=start;dragging.clip.duration=original.values.duration-delta;if(sourceBounded){dragging.clip.sourceIn=original.values.sourceIn+delta;dragging.clip.sourceOut=original.values.sourceOut;}
    }else {
      const minStart=Math.min(...dragging.originals.map(o=>o.values.start));delta=Math.max(-minStart,delta);const lane=timelineLaneAtPointer(e,dragging.kind,dragging.hoverLane);let trackDelta=0;
      if(lane){if(dragging.hoverLane!==lane){dragging.hoverLane?.classList.remove('an-lane-hover');dragging.hoverLane=lane;lane.classList.add('an-lane-hover');}trackDelta=Number(lane.dataset.track)-dragging.startTrack;}
      const primaryOriginal=dragging.originals.find(o=>o.item===dragging.clip),primaryTargetTrack=clamp((primaryOriginal?.values.track||0)+trackDelta,0,dragging.kind==='video'?project.videoTracks-1:dragging.kind==='audio'?project.audioTracks-1:0),primaryCollection=entryById(dragging.clip.id).collection;
      if(project.timelineSnap){const moving=[{start:primaryOriginal.values.start,duration:primaryOriginal.values.duration}],stationary=primaryCollection.filter(c=>!dragging.movedIds.has(c.id)&&c.track===primaryTargetTrack),snap=snappedMoveDelta({moving,stationary,proposedDelta:delta,threshold:8/px,extraTimes:[0,fixedSequenceEnd(),project.playhead,project.inPoint,project.outPoint]});delta=snap.delta;showSnapGuide(snap.guide); }else showSnapGuide(null);
      const sequenceEnd=fixedSequenceEnd();if(sequenceEnd!==null){const selectedEnd=Math.max(...dragging.originals.map(o=>o.values.start+o.values.duration));delta=Math.min(delta,sequenceEnd-selectedEnd);}
      for(const original of dragging.originals){original.item.start=Math.max(0,original.values.start+delta);if(original.kind===dragging.kind)original.item.track=clamp((original.values.track||0)+trackDelta,0,original.kind==='video'?project.videoTracks-1:original.kind==='audio'?project.audioTracks-1:0);}
      for(let i=0;i<dragging.ghosts.length;i++){const original=dragging.originals[i],ghost=dragging.ghosts[i],targetLane=grid.querySelector(`.an-track-lane[data-kind="${original.kind}"][data-track="${original.item.track||0}"]`);if(!targetLane)continue;const laneRect=targetLane.getBoundingClientRect();ghost.style.left=`${laneRect.left+original.item.start*px}px`;ghost.style.top=`${laneRect.top+4}px`;}
    }
    if(dragging.trimEdge){const el=grid.querySelector(`[data-clip="${CSS.escape(dragging.clip.id)}"]`);if(el){el.style.left=`${dragging.clip.start*px}px`;el.style.width=`${Math.max(16,dragging.clip.duration*px)}px`;const dur=el.querySelector('.an-clip-dur');if(dur)dur.textContent=clipDurationLabel(dragging.clip);}}
    if(dragging.trimEdge)drawViewer();
  });
  grid.addEventListener('pointerup',()=>{if(handPan){const temporary=handPan.temporary;handPan=null;root.classList.remove('hand-panning');if(temporary)setActiveTool('select');return;}if(trackResize){const state=trackResize,changed=Math.abs(trackHeight(state.kind,state.track)-state.startHeight)>1e-8;trackResize=null;if(changed){markDirty();renderTimeline();}else grid.querySelector(`[data-track-resize="${state.kind}"][data-track="${state.track}"]`)?.classList.remove('dragging');return;}if(trackReorder){const state=trackReorder;trackReorder=null;if(moveTimelineTrack(state.kind,state.from,state.to)){markDirty();renderAll();notify(`Moved ${state.kind==='video'?'video':'audio'} track to ${state.kind==='video'?'V':'A'}${state.to+1}`);}else for(const row of grid.querySelectorAll('.an-track-row'))row.classList.remove('reorder-source','reorder-target');return;}if(gapPress){const state=gapPress;gapPress=null;setTimelineSelection([]);selectedGap={key:state.key,kind:state.kind,track:state.track,start:state.start,end:state.end};renderTimeline();syncInspector();return;}if(sequenceMarkerDrag){sequenceMarkerDrag=null;markDirty();renderTimeline();}if(scrubbing)scrubbing=null;if(marqueeDrag)finishMarquee();if(dragging){const changed=dragging.moved,movedIds=dragging.movedIds;if(changed)commitTimelineOverwrite(movedIds);clearTimelineDrag(false);if(changed)markDirty();renderAll();}});
  grid.addEventListener('pointercancel',()=>{if(handPan){const temporary=handPan.temporary;handPan=null;root.classList.remove('hand-panning');if(temporary)setActiveTool('select');}if(trackResize){setTrackHeight(trackResize.kind,trackResize.track,trackResize.startHeight);trackResize=null;renderTimeline();}if(trackReorder){trackReorder=null;for(const row of grid.querySelectorAll('.an-track-row'))row.classList.remove('reorder-source','reorder-target');}gapPress=null;if(sequenceMarkerDrag){sequenceMarkerDrag=null;renderTimeline();}scrubbing=null;if(marqueeDrag){$('#anMarquee').classList.remove('show');marqueeDrag=null;renderTimeline();}if(dragging){clearTimelineDrag(true);renderAll();}});
  grid.addEventListener('pointerleave',clearRazorGuide);
  grid.addEventListener('keydown',e=>{const resize=e.target.closest?.('[data-track-resize]');if(resize&&['ArrowUp','ArrowDown','Home'].includes(e.key)){const kind=resize.dataset.trackResize,track=Number(resize.dataset.track),next=e.key==='Home'?DEFAULT_TRACK_HEIGHT:trackHeight(kind,track)+(e.key==='ArrowUp'?8:-8);setTrackHeight(kind,track,next);markDirty();renderTimeline();grid.querySelector(`[data-track-resize="${kind}"][data-track="${track}"]`)?.focus();e.preventDefault();return;}const grip=e.target.closest?.('[data-track-move]');if(grip&&['ArrowUp','ArrowDown'].includes(e.key)){const kind=grip.dataset.trackMove,from=Number(grip.dataset.track),count=kind==='video'?project.videoTracks:project.audioTracks,to=clamp(from+(e.key==='ArrowUp'?-1:1),0,count-1);if(moveTimelineTrack(kind,from,to)){markDirty();renderAll();grid.querySelector(`[data-track-move="${kind}"][data-track="${to}"]`)?.focus();}e.preventDefault();return;}const marker=e.target.closest?.('[data-sequence-marker]');if(!marker||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;const kind=marker.dataset.sequenceMarker,current=kind==='in'?project.inPoint:project.outPoint,next=e.key==='Home'?0:e.key==='End'?duration():current+(e.key==='ArrowRight'?1:-1)/project.fps;setSequenceMarkerValue(kind,next);markDirty();renderTimeline();grid.querySelector(`[data-sequence-marker="${kind}"]`)?.focus();e.preventDefault();});
  grid.addEventListener('dblclick',e=>{const resize=e.target.closest?.('[data-track-resize]');if(!resize)return;setTrackHeight(resize.dataset.trackResize,Number(resize.dataset.track),DEFAULT_TRACK_HEIGHT);markDirty();renderTimeline();e.preventDefault();});
  grid.addEventListener('auxclick',e=>{if(e.button===1)e.preventDefault();});
  grid.addEventListener('click',e=>{
    const gap=e.target.closest('.an-gap');if(gap){setTimelineSelection([]);selectedGap={key:gap.dataset.gap,kind:gap.dataset.kind,track:Number(gap.dataset.track),start:Number(gap.dataset.start),end:Number(gap.dataset.end)};renderTimeline();syncInspector();return;}
    if(e.target.closest('[data-time-display]')){toggleTimelineDisplay();return;}
    const target=e.target.closest('[data-target-track]');if(target){setActiveTimelineTrack(target.dataset.targetTrack,Number(target.dataset.track));return;}
    const visibility=e.target.closest('[data-toggle-track-visibility]');if(visibility){toggleVideoTrackVisibility(Number(visibility.dataset.toggleTrackVisibility));return;}
    const remove=e.target.closest('[data-remove-track]');if(remove){removeTimelineTrack(remove.dataset.removeTrack,Number(remove.dataset.track));return;}
    const add=e.target.closest('[data-add-track]');if(!add)return;if(add.dataset.addTrack==='video'){project.videoTracks=clamp(project.videoTracks+1,1,MAX_VIDEO_TRACKS);activeVideoTrack=project.videoTracks-1;}else{project.audioTracks=clamp(project.audioTracks+1,0,MAX_AUDIO_TRACKS);activeAudioTrack=Math.max(0,project.audioTracks-1);}ensureTrackHeightCounts();markDirty();renderTimeline();
  });

  let dropLane=null;
  root.addEventListener('dragover',e=>{
    const items=[...(e.dataTransfer?.items||[])];if(!items.some(item=>item.kind==='file'&&(String(item.type||'').startsWith('video/')||!item.type)))return;
    e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect='copy';
    const lane=e.target.closest?.('.an-track-lane[data-kind="video"]')||grid.querySelector('.an-track-lane[data-kind="video"][data-track="0"]');
    if(dropLane!==lane){dropLane?.classList.remove('an-drop-target');dropLane=lane;dropLane?.classList.add('an-drop-target');}
  });
  root.addEventListener('dragleave',e=>{if(e.relatedTarget&&root.contains(e.relatedTarget))return;dropLane?.classList.remove('an-drop-target');dropLane=null;});
  root.addEventListener('drop',e=>{
    const files=[...(e.dataTransfer?.files||[])].filter(isVideoFile);if(!files.length)return;
    e.preventDefault();e.stopPropagation();const hitLane=e.target.closest?.('.an-track-lane[data-kind="video"]'),lane=hitLane||dropLane||grid.querySelector('.an-track-lane[data-kind="video"][data-track="0"]');
    const track=Number(lane?.dataset.track)||0,start=hitLane?pointerTime(e,hitLane):project.playhead;dropLane?.classList.remove('an-drop-target');dropLane=null;addVideoFiles(files,{track,start});
  });

  canvas.addEventListener('pointerdown',e=>{
    if(inlineTextDismissEvents.has(e)){e.preventDefault();return;}
    const clip=selectedClip();
    if(activeTool==='text'&&!drawMode&&!framingMode){
      const hit=hitTextControl(e);
      if(hit){if(inlineTextId)finishInlineTextEdit(false);setTimelineSelection([hit.text.id],hit.text.id);root.querySelector('[data-panel="text"]')?.click();syncInspector();drawViewer();beginInlineTextEdit(hit.text);}
      else{const rect=canvas.getBoundingClientRect();addTextAtTime(project.playhead,{x:(e.clientX-rect.left)/Math.max(1,rect.width),y:(e.clientY-rect.top)/Math.max(1,rect.height)});}
      e.preventDefault();return;
    }
    if(!drawMode&&!framingMode){
      const hit=hitTextControl(e);
      if(hit){
        if(inlineTextId)finishInlineTextEdit(false);setTimelineSelection([hit.text.id],hit.text.id);root.querySelector('[data-panel="text"]')?.click();
        const rect=canvas.getBoundingClientRect(),point=viewerPoint(e),startAngle=Math.atan2(point.y-hit.layout.cy,point.x-hit.layout.cx);
        textDrag={mode:hit.mode,textId:hit.text.id,startX:e.clientX,startY:e.clientY,x:hit.text.x,y:hit.text.y,width:rect.width,height:rect.height,startScale:hit.text.scale,startDistance:Math.max(1,Math.hypot(point.x-hit.layout.cx,point.y-hit.layout.cy)),startAngle,startRotation:hit.text.rotation};
        canvas.setPointerCapture(e.pointerId);syncInspector();drawViewer();e.preventDefault();return;
      }
    }
    if(framingMode&&clip&&!drawMode){
      const framing=clip.framing||(clip.framing={fit:'contain',scale:1,x:0,y:0});
      framingDrag={startX:e.clientX,startY:e.clientY,x:framing.x,y:framing.y};
      canvas.setPointerCapture(e.pointerId);e.preventDefault();return;
    }
    if(!drawMode||!clip)return; const r=canvas.getBoundingClientRect(); activeStroke={color:$('#anDrawColor').value,width:Number($('#anDrawWidth').value)||6,points:[{x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}]}; clip.strokes.push(activeStroke); canvas.setPointerCapture(e.pointerId); e.preventDefault();
  });
  canvas.addEventListener('pointermove',e=>{
    if(textDrag){
      const text=project.texts.find(item=>item.id===textDrag.textId);if(!text)return;
      if(textDrag.mode==='move'){text.x=clamp(textDrag.x+(e.clientX-textDrag.startX)/textDrag.width,0,1);text.y=clamp(textDrag.y+(e.clientY-textDrag.startY)/textDrag.height,0,1);}
      else if(textDrag.mode==='scale'){const layout=textLayout(ctx,text,canvas.width,canvas.height),point=viewerPoint(e),distance=Math.hypot(point.x-layout.cx,point.y-layout.cy);text.scale=clamp(textDrag.startScale*distance/textDrag.startDistance,.25,4);}
      else if(textDrag.mode==='rotate'){const layout=textLayout(ctx,text,canvas.width,canvas.height),point=viewerPoint(e),angle=Math.atan2(point.y-layout.cy,point.x-layout.cx);let rotation=textDrag.startRotation+(angle-textDrag.startAngle)*180/Math.PI;while(rotation>180)rotation-=360;while(rotation<-180)rotation+=360;text.rotation=rotation;}
      syncInspector();drawViewerLive();positionInlineTextEditor();return;
    }
    if(framingDrag){const c=selectedClip(),r=canvas.getBoundingClientRect();if(!c)return;c.framing.x=clamp(framingDrag.x+(e.clientX-framingDrag.startX)*2/r.width,-1,1);c.framing.y=clamp(framingDrag.y+(e.clientY-framingDrag.startY)*2/r.height,-1,1);drawViewer();return;}
    if(activeStroke){const r=canvas.getBoundingClientRect();activeStroke.points.push({x:clamp((e.clientX-r.left)/r.width,0,1),y:clamp((e.clientY-r.top)/r.height,0,1)});drawViewer();return;}
    if(!drawMode&&!framingMode){const hit=hitTextControl(e);canvas.style.cursor=hit?.mode==='scale'?'nwse-resize':hit?.mode==='rotate'?'grab':hit?'move':activeTool==='text'?'text':'default';}
  });
  canvas.addEventListener('pointerup',()=>{if(textDrag){textDrag=null;markDirty();syncInspector();drawViewer();}if(framingDrag){framingDrag=null;markDirty();syncInspector();}if(activeStroke){activeStroke=null;markDirty();renderTimeline();}});
  canvas.addEventListener('pointercancel',()=>{textDrag=null;framingDrag=null;activeStroke=null;});
  canvas.addEventListener('dblclick',e=>{
    if(!drawMode&&!framingMode){const hit=hitTextControl(e);if(hit){setTimelineSelection([hit.text.id],hit.text.id);root.querySelector('[data-panel="text"]')?.click();syncInspector();drawViewer();beginInlineTextEdit(hit.text);e.preventDefault();return;}}
    const clip=clipsAt(project.playhead).at(-1)||selectedClip();
    if(clip)setTimelineSelection([clip.id],clip.id);
    if(!clip){notify('Move the playhead over a shot first');return;}
    framingMode=!framingMode;drawMode=false;canvas.style.cursor=framingMode?'move':'default';
    root.querySelector('[data-panel="clip"]')?.click();syncInspector();drawViewer();
  });
  canvas.addEventListener('wheel',e=>{
    if(!framingMode||!selectedClip())return;e.preventDefault();const framing=selectedClip().framing;
    framing.scale=clamp(framing.scale*Math.exp(-e.deltaY*.001),.25,4);deferMarkDirty();syncInspector();drawViewer();
  },{passive:false});
  inlineTextEditor.addEventListener('input',()=>{const text=project.texts.find(item=>item.id===inlineTextId);if(!text)return;text.content=inlineTextEditor.value;$('#anText').value=text.content;drawViewerLive();positionInlineTextEditor();});
  inlineTextEditor.addEventListener('blur',()=>finishInlineTextEdit(false));
  inlineTextEditor.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape'){finishInlineTextEdit(true);canvas.focus();e.preventDefault();}else if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){finishInlineTextEdit(false);canvas.focus();e.preventDefault();}});
  document.addEventListener('pointerdown',e=>{
    if(e.button!==0||!inlineTextId||inlineTextEditor.contains(e.target))return;
    if(e.target===canvas)inlineTextDismissEvents.add(e);
    finishInlineTextEdit(false);
  },true);

  $('#anBack').onclick=closeEditor;
  $('#anPlay').onclick=()=>setPlaying(!playing);
  $('#anPrev').onclick=()=>setPlayhead(project.playhead-1/project.fps);
  $('#anNext').onclick=()=>setPlayhead(project.playhead+1/project.fps);
  $('#anInspector').onclick=()=>root.classList.toggle('panel-open');
  $('#anZoom').oninput=e=>applyTimelineZoom(e.target.value);$('#anZoom').onchange=()=>deferMarkDirty(0);
  $('#anSequenceSettings').onclick=openSequenceSettings;$('#anSequenceMode').onchange=syncSequenceModeUi;$('#anSequenceCancel').onclick=()=>$('#anSequenceModal').classList.remove('open');$('#anSequenceApply').onclick=applySequenceSettings;
  root.querySelectorAll('[data-sequence-seconds]').forEach(button=>button.onclick=()=>{$('#anSequenceMode').value='fixed';syncSequenceModeUi();$('#anSequenceDuration').value=timecode(Number(button.dataset.sequenceSeconds),project.fps);});
  $('#anSetIn').onclick=setSequenceIn;$('#anSetOut').onclick=setSequenceOut;$('#anClearRange').onclick=clearSequenceRange;
  const timelineResizer=$('#anTimelineResizer');
  timelineResizer.addEventListener('pointerdown',e=>{timelineResize={startY:e.clientY,startHeight:project.timelineHeight};timelineResizer.classList.add('dragging');timelineResizer.setPointerCapture?.(e.pointerId);e.preventDefault();});
  timelineResizer.addEventListener('pointermove',e=>{if(!timelineResize)return;project.timelineHeight=clamp(timelineResize.startHeight+timelineResize.startY-e.clientY,180,Math.max(180,window.innerHeight-220));applyTimelineHeight();resizeViewer();});
  timelineResizer.addEventListener('pointerup',()=>{if(!timelineResize)return;timelineResize=null;timelineResizer.classList.remove('dragging');markDirty();});
  timelineResizer.addEventListener('pointercancel',()=>{timelineResize=null;timelineResizer.classList.remove('dragging');applyTimelineHeight();});
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
  for(const id of ['anDuration','anAudioDuration'])$('#'+id).onchange=e=>{if(e.target.value===''){syncInspector();return;}applySelectedDuration(Math.max(1,Math.round(Number(e.target.value)*project.fps))/project.fps);};
  for(const id of ['anDurationFrames','anAudioDurationFrames'])$('#'+id).onchange=e=>{if(e.target.value===''){syncInspector();return;}applySelectedDuration(clamp(Math.round(Number(e.target.value)||1),1,36000)/project.fps);};
  const applyFraming=fit=>{const clips=selectedVisualClips();if(!clips.length)return;for(const clip of clips)clip.framing={fit,scale:1,x:0,y:0};markDirty();syncInspector();drawViewer();};
  $('#anFrameFit').onclick=()=>applyFraming('contain');
  $('#anFrameFill').onclick=()=>applyFraming('cover');
  $('#anFrameReset').onclick=()=>applyFraming('contain');
  $('#anToggleClipVisibility').onclick=toggleSelectedVisualVisibility;
  $('#anFrameScale').oninput=e=>{const clips=selectedVisualClips();if(!clips.length)return;const scale=clamp(Number(e.target.value)/100,.25,4);for(const clip of clips){clip.framing=clip.framing||{fit:'contain',scale:1,x:0,y:0};clip.framing.scale=scale;}const label=`${Math.round(scale*100)}%`;$('#anFrameScaleVal').value=label;$('#anFrameScaleVal').textContent=label;drawViewer();};
  $('#anFrameScale').onchange=()=>{if(selectedVisualClips().length)markDirty();};
  $('#anDeleteClip').onclick=deleteSelected;
  $('#anSplit').onclick=splitSelected;
  $('#anAudioSplit').onclick=splitSelected;
  $('#anAudioDelete').onclick=deleteSelected;
  $('#anAudioVolume').oninput=e=>{const clips=selectedAudioClips();if(!clips.length)return;const volume=clamp(Number(e.target.value)/100,0,2);for(const audio of clips){audio.volume=volume;updateActiveAudioGain(audio);}const label=`${Math.round(volume*100)}%`;$('#anAudioVolumeVal').value=label;$('#anAudioVolumeVal').textContent=label;$('#anAudioMute').classList.toggle('on',volume===0);$('#anAudioMute').textContent=volume===0?'Unmute selected':'Mute selected';};
  $('#anAudioVolume').onchange=()=>{if(selectedAudioClips().length)markDirty();};
  $('#anAudioMute').onclick=()=>{const clips=selectedAudioClips();if(!clips.length)return;const mute=clips.some(audio=>audio.volume>0);for(const audio of clips){if(mute){if(audio.volume>0)audio.lastVolume=audio.volume;audio.volume=0;}else audio.volume=clamp(Number(audio.lastVolume)||1,0,2);updateActiveAudioGain(audio);}markDirty();syncInspector();};
  $('#anLink').onclick=toggleLinkSelection;
  $('#anAddText').onclick=upsertTextLayer;
  $('#anClearText').onclick=()=>{if(selectedText())deleteSelected();};
  for(const id of ['anTextSize','anTextColor','anTextScale','anTextRotation','anTextDuration','anTextX','anTextY'])$('#'+id).addEventListener('input',updateSelectedTextFromControls);
  $('#anTextDuration').addEventListener('input',()=>{if(selectedText())renderTimeline();});
  $('#anText').addEventListener('input',()=>{const text=selectedText();if(text){text.content=$('#anText').value;if(text.id===inlineTextId)inlineTextEditor.value=text.content;drawViewerLive();positionInlineTextEditor();}});
  $('#anText').addEventListener('change',()=>{if(selectedText()){markDirty();renderTimeline();drawViewer();}});
  for(const id of ['anTextSize','anTextColor','anTextScale','anTextRotation','anTextDuration','anTextX','anTextY'])$('#'+id).addEventListener('change',()=>{if(selectedText()){markDirty();drawViewer();}});
  $('#anDrawToggle').onclick=()=>{if(!selectedClip()){notify('Select a clip first');return;}drawMode=!drawMode;if(drawMode)framingMode=false;syncInspector();canvas.style.cursor=drawMode?'crosshair':'default';};
  $('#anClearDraw').onclick=()=>{const c=selectedClip();if(c){c.strokes=[];markDirty();drawViewer();}};
  $('#anTcToggle').onclick=()=>{project.timecode=!project.timecode;markDirty();syncInspector();drawViewer();};
  $('#anCounterMode').onchange=e=>{project.counterMode=e.target.value;markDirty();renderAll();};
  $('#anProjectFps').onchange=e=>{project.fps=Number(e.target.value);markDirty();renderAll();updateAudioTrimUi();};
  $('#anFooterQuality').onchange=e=>{project.previewQuality=e.target.value;markDirty();applyPreviewQuality();resizeViewer();syncInspector();};
  $('#anFooterAspect').onchange=e=>{project.aspect=ASPECT_RATIOS[e.target.value]?e.target.value:'16:9';markDirty();applyPreviewQuality();resizeViewer();syncInspector();};
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
  root.querySelectorAll('.an-tab').forEach(tab=>tab.onclick=()=>{root.querySelectorAll('.an-tab,.an-panel').forEach(el=>el.classList.remove('on'));tab.classList.add('on');root.querySelector(`[data-panel-body="${tab.dataset.panel}"]`).classList.add('on');syncInspector();});
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

  window.addEventListener('resize',()=>{if(open)resizeViewer();});
  window.addEventListener('keydown',e=>{
    if(!open)return;
    const form=e.target.matches('input,textarea,select'),key=e.key.toLowerCase(),mod=e.ctrlKey||e.metaKey;
    if(mod&&(key==='z'||key==='y')){if(form&&!inlineTextId)e.target.blur();const wantsRedo=key==='y'||e.shiftKey;wantsRedo?redoAnimatics():undoAnimatics();e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&mod&&key==='c'){copyTimelineSelection(false);e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&mod&&key==='x'){copyTimelineSelection(true);e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&mod&&key==='v'){pasteTimelineSelection();e.preventDefault();e.stopImmediatePropagation();}
    else if(e.key==='Escape'){if(inlineTextId)finishInlineTextEdit(true);else if($('#anAudioTrimModal').classList.contains('open'))finishAudioTrimmer(false);else if($('#anSequenceModal').classList.contains('open'))$('#anSequenceModal').classList.remove('open');else if($('#anExportModal').classList.contains('open'))$('#anExportModal').classList.remove('open');else if(selectedGap){selectedGap=null;renderTimeline();}else if(activeTool!=='select')setActiveTool('select');else closeEditor();e.preventDefault();e.stopImmediatePropagation();}
    else if(e.code==='Space'&&!form){if(!spaceHand){spaceHand={startedAt:Date.now(),used:false};setActiveTool('hand');}e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&mod&&key==='a'){setTimelineSelection([...project.clips,...project.texts,...project.audio].map(item=>item.id),primarySelectionId());renderTimeline();syncInspector();e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&mod&&key==='l'){toggleLinkSelection();e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&mod&&key==='h'){toggleSelectedVisualVisibility();e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&!mod&&['v','t','c','h'].includes(key)){setActiveTool(key==='v'?'select':key==='t'?'text':key==='c'?'razor':'hand');e.preventDefault();e.stopImmediatePropagation();}
    else if(!form&&!mod&&key==='s'){project.timelineSnap=!project.timelineSnap;markDirty();renderTimeline();e.preventDefault();e.stopImmediatePropagation();}
    else if(key==='i'&&!form){setSequenceIn();e.preventDefault();e.stopImmediatePropagation();}
    else if(key==='o'&&!form){setSequenceOut();e.preventDefault();e.stopImmediatePropagation();}
    else if((e.key==='Delete'||e.key==='Backspace')&&!e.target.matches('input,textarea')){deleteSelected();e.preventDefault();e.stopImmediatePropagation();}
  },true);
  window.addEventListener('keyup',e=>{if(!open||e.code!=='Space'||!spaceHand)return;const state=spaceHand;spaceHand=null;if(handPan){grid.releasePointerCapture?.(handPan.pointerId);handPan=null;root.classList.remove('hand-panning');state.used=true;}setActiveTool('select');if(!state.used&&Date.now()-state.startedAt<260)setPlaying(!playing);e.preventDefault();e.stopImmediatePropagation();},true);

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
      const exportAudio=project.audio.map(a=>{const clipStart=Math.max(a.start,exportStart),clipEnd=Math.min(a.start+a.duration,exportEnd);return clipEnd>clipStart?{...a,start:clipStart-exportStart,sourceIn:(a.sourceIn||0)+(clipStart-a.start),duration:clipEnd-clipStart}:null;}).filter(Boolean);
      for(let i=0;i<segments.length;i++){
        const c=document.createElement('canvas');c.width=w;c.height=h;await drawViewer(c.getContext('2d'),w,h,segments[i].start,burn,true);const blob=await new Promise(r=>c.toBlob(r,'image/png'));c.width=c.height=0;
        await window.RefBoardAPI.appendAnimaticFrame(token,{duration:segments[i].duration,data:await blob.arrayBuffer()});bar.style.width=`${Math.round((i+1)/(segments.length+exportAudio.length)*85)}%`;
      }
      for(let i=0;i<exportAudio.length;i++){const a=exportAudio[i];if(!a.blob)continue;await window.RefBoardAPI.appendAnimaticAudio(token,{name:a.name,start:a.start,sourceIn:a.sourceIn||0,duration:a.duration,volume:a.volume,data:await a.blob.arrayBuffer()});}
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

  async function collectTimelineExportAssets({fps,width,height,append,onProgress=()=>{}}){
    const assets=new Map(),jobs=[];
    const seenImages=new Set(),seenVideos=new Set(),seenAudio=new Set();
    for(const clip of project.clips){
      if(isVideoClip(clip)){if(!seenVideos.has(clip.mediaId)){seenVideos.add(clip.mediaId);jobs.push({key:`video:${clip.mediaId}`,kind:'video',entry:clip});}}
      else if(!seenImages.has(clip.itemId)){seenImages.add(clip.itemId);jobs.push({key:`image:${clip.itemId}`,kind:'image',entry:clip});}
      if(clip.strokes?.length)jobs.push({key:`stroke:${clip.id}`,kind:'stroke',entry:clip});
    }
    for(const audio of project.audio)if(!seenAudio.has(audio.mediaId)){seenAudio.add(audio.mediaId);jobs.push({key:`audio:${audio.mediaId}`,kind:'audio',entry:audio});}
    let assetIndex=0;
    for(const job of jobs){
      let blob,name,meta;
      if(job.kind==='image'){
        const image=getImage(job.entry.itemId);blob=await getBlob(job.entry.itemId);if(!blob?.size)throw new Error(`Missing original image: ${job.entry.name}`);name=job.entry.name||image?.name||`Image ${assetIndex+1}`;meta={kind:'image',width:image?.w||0,height:image?.h||0,durationFrames:Math.max(1,...project.clips.filter(c=>c.itemId===job.entry.itemId).map(c=>premiereFrame(c.duration,fps)))};
      }else if(job.kind==='video'){
        blob=job.entry.blob||mediaResources.get(job.entry.mediaId)?.blob;if(!blob?.size)throw new Error(`Missing video: ${job.entry.name}`);name=job.entry.name||`Video ${assetIndex+1}`;meta={kind:'video',width:job.entry.videoWidth||0,height:job.entry.videoHeight||0,durationFrames:premiereFrame(job.entry.originalDuration||job.entry.sourceOut||job.entry.duration,fps)};
      }else if(job.kind==='audio'){
        blob=job.entry.blob||mediaResources.get(job.entry.mediaId)?.blob;if(!blob?.size)throw new Error(`Missing audio: ${job.entry.name}`);name=job.entry.name||`Audio ${assetIndex+1}`;meta={kind:'audio',channels:2,durationFrames:premiereFrame(job.entry.originalDuration||job.entry.sourceOut||job.entry.duration,fps)};
      }else if(job.kind==='stroke'){
        blob=await premiereOverlayBlob(g=>{g.lineCap='round';g.lineJoin='round';for(const stroke of job.entry.strokes||[]){if(!stroke.points?.length)continue;g.beginPath();g.strokeStyle=stroke.color||'#ff5c5c';g.lineWidth=(stroke.width||6)*(width/1280);stroke.points.forEach((point,index)=>index?g.lineTo(point.x*width,point.y*height):g.moveTo(point.x*width,point.y*height));g.stroke();}},width,height);name=`${String(job.entry.name||'Clip').replace(/\.[^.]+$/,'')} Drawings.png`;meta={kind:'image',width,height,durationFrames:premiereFrame(job.entry.duration,fps)};
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
    load:(raw,mediaBlobs)=>{releaseImportedMedia();timelineClipboard=null;activeVideoTrack=0;activeAudioTrack=0;project=normalizeProject(raw,mediaBlobs);rememberProjectMedia();const first=project.clips[0]?.id||project.texts[0]?.id||project.audio[0]?.id||null;setTimelineSelection(first?[first]:[],first);resetAnimaticsHistory();renderAll();},
    clear:()=>{releaseImportedMedia();timelineClipboard=null;activeVideoTrack=0;activeAudioTrack=0;project=freshProject();setTimelineSelection([]);resetAnimaticsHistory();renderAll();},
  };
}
