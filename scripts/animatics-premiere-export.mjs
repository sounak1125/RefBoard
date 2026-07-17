const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function premiereFrame(seconds, fps) {
  return Math.max(0, Math.round((Number(seconds) || 0) * fps));
}

export function premiereFileUrl(filePath) {
  const raw = String(filePath || '').replace(/\\/g, '/');
  if (/^\/\//.test(raw)) {
    const [host, ...parts] = raw.slice(2).split('/');
    return `file://${host}/${parts.map(encodeURIComponent).join('/')}`;
  }
  const absolute = /^[A-Za-z]:\//.test(raw) ? `/${raw}` : raw.startsWith('/') ? raw : `/${raw}`;
  return `file://localhost${absolute.split('/').map((part, index) => index === 1 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join('/')}`;
}

export function safePremiereAssetName(name, fallback = 'media.bin') {
  const cleaned = String(name || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

function xml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' })[ch]);
}

function rateXml(fps) {
  return `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
}

function mediaKey(item, kind) {
  if (kind === 'image') return `image:${item.itemId}`;
  if (kind === 'video') return `video:${item.mediaId}`;
  if (kind === 'audio') return `audio:${item.mediaId}`;
  return `${kind}:${item.id}`;
}

function clippedTimelineItem(item, kind, fps, exportStart, exportEnd, asset) {
  const visibleStart = Math.max(Number(item.start) || 0, exportStart);
  const visibleEnd = Math.min((Number(item.start) || 0) + (Number(item.duration) || 0), exportEnd);
  if (visibleEnd <= visibleStart + 1e-9 || (!asset && kind !== 'text')) return null;
  const timelineStart = premiereFrame(visibleStart - exportStart, fps);
  const timelineEnd = Math.max(timelineStart + 1, premiereFrame(visibleEnd - exportStart, fps));
  const sourceOffset = visibleStart - (Number(item.start) || 0);
  const sourceInSeconds = kind === 'video' || kind === 'audio' ? (Number(item.sourceIn) || 0) + sourceOffset : sourceOffset;
  const sourceIn = premiereFrame(sourceInSeconds, fps);
  return {
    id: item.id,
    name: item.name || asset?.name || (kind === 'text' ? 'Text' : 'Clip'),
    kind,
    start: timelineStart,
    end: timelineEnd,
    in: sourceIn,
    out: sourceIn + (timelineEnd - timelineStart),
    asset,
    enabled: item.enabled !== false,
    still: kind === 'image' || kind === 'overlay',
    volume: kind === 'audio' ? clamp(Number.isFinite(Number(item.volume)) ? Number(item.volume) : 1, 0, 2) : 1,
    framing: kind === 'image' || kind === 'video' ? item.framing || null : null,
    text: kind === 'text' ? {
      content: String(item.content ?? ''),
      size: clamp(Number(item.size) || 42, 8, 300),
      color: String(item.color || '#ffffff'),
      scale: clamp(Number(item.scale) || 1, .25, 4),
      rotation: clamp(Number(item.rotation) || 0, -180, 180),
      x: clamp(Number.isFinite(Number(item.x)) ? Number(item.x) : .5, 0, 1),
      y: clamp(Number.isFinite(Number(item.y)) ? Number(item.y) : .82, 0, 1),
    } : null,
  };
}

export function buildPremiereTimeline({ project, name, fps, width, height, exportStart = 0, exportEnd, assets }) {
  const end = Number.isFinite(exportEnd) ? exportEnd : Math.max(0,
    ...project.clips.map(item => item.start + item.duration),
    ...project.texts.map(item => item.start + item.duration),
    ...project.audio.map(item => item.start + item.duration));
  const durationFrames = Math.max(1, premiereFrame(end - exportStart, fps));
  const lookup = key => assets instanceof Map ? assets.get(key) : assets?.[key];
  const videoTracks = Array.from({ length: Math.max(1, Number(project.videoTracks) || 1) }, () => []);
  const videoTrackEnabled = videoTracks.map((_, index) => project.videoTrackEnabled?.[index] !== false);
  const strokeTracks = Array.from({ length: videoTracks.length }, () => []);

  for (const clip of project.clips) {
    const kind = clip.mediaKind === 'video' ? 'video' : 'image';
    const entry = clippedTimelineItem(clip, kind, fps, exportStart, end, lookup(mediaKey(clip, kind)));
    if (entry) videoTracks[clamp(Number(clip.track) || 0, 0, videoTracks.length - 1)].push(entry);
    const overlay = clippedTimelineItem(clip, 'overlay', fps, exportStart, end, lookup(`stroke:${clip.id}`));
    if (overlay) strokeTracks[clamp(Number(clip.track) || 0, 0, strokeTracks.length - 1)].push(overlay);
  }

  const textTrack = project.texts.map(text => clippedTimelineItem(text, 'text', fps, exportStart, end, null)).filter(Boolean);
  const audioTracks = Array.from({ length: Math.max(0, Number(project.audioTracks) || 0) }, () => []);
  for (const audio of project.audio) {
    const entry = clippedTimelineItem(audio, 'audio', fps, exportStart, end, lookup(mediaKey(audio, 'audio')));
    if (entry && audioTracks.length) audioTracks[clamp(Number(audio.track) || 0, 0, audioTracks.length - 1)].push(entry);
  }

  const allVideoTracks = [...videoTracks];
  const allVideoTrackEnabled = [...videoTrackEnabled];
  for (let index = 0; index < strokeTracks.length; index++) if (strokeTracks[index].length) { allVideoTracks.push(strokeTracks[index]); allVideoTrackEnabled.push(videoTrackEnabled[index]); }
  if (textTrack.length) { allVideoTracks.push(textTrack); allVideoTrackEnabled.push(true); }
  for (const track of [...allVideoTracks, ...audioTracks]) track.sort((a, b) => a.start - b.start || a.end - b.end);
  return { name, fps, width, height, durationFrames, videoTracks: allVideoTracks, videoTrackEnabled: allVideoTrackEnabled, audioTracks };
}

function transformXml(clip, width, height) {
  const framing = clip.framing;
  if (!framing || !clip.asset.width || !clip.asset.height) return '';
  const fit = framing.fit === 'cover' ? Math.max(width / clip.asset.width, height / clip.asset.height) : Math.min(width / clip.asset.width, height / clip.asset.height);
  const scale = Math.max(.01, fit * (Number(framing.scale) || 1) * 100);
  // XMEML Basic Motion stores the center as a normalized offset from the
  // sequence center. Pixel coordinates push imported footage off-canvas.
  const x = clamp(Number(framing.x) || 0, -1, 1);
  const y = clamp(Number(framing.y) || 0, -1, 1);
  return `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>scale</parameterid><name>Scale</name><valuemin>0</valuemin><valuemax>10000</valuemax><value>${scale.toFixed(6)}</value></parameter><parameter><parameterid>center</parameterid><name>Center</name><value><horiz>${x.toFixed(6)}</horiz><vert>${y.toFixed(6)}</vert></value></parameter></effect></filter>`;
}

function volumeXml(clip) {
  if (clip.kind !== 'audio' || Math.abs(clip.volume - 1) < 1e-9) return '';
  return `<filter><effect><name>Audio Levels</name><effectid>audiolevels</effectid><effectcategory>audiolevels</effectcategory><effecttype>audiolevels</effecttype><mediatype>audio</mediatype><parameter><parameterid>level</parameterid><name>Level</name><valuemin>0</valuemin><valuemax>3.981072</valuemax><value>${clip.volume.toFixed(6)}</value></parameter></effect></filter>`;
}

function fileXml(asset, fps, emitted) {
  const id = `file-${xml(asset.id)}`;
  if (emitted.has(id)) return `<file id="${id}"/>`;
  emitted.add(id);
  const duration = Math.max(1, Number(asset.durationFrames) || 1);
  const sample = asset.kind === 'audio'
    ? `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>${Math.max(1, Number(asset.channels) || 2)}</channelcount></audio>`
    : `<video><samplecharacteristics>${rateXml(fps)}<width>${Math.max(1, Number(asset.width) || 1)}</width><height>${Math.max(1, Number(asset.height) || 1)}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>`;
  return `<file id="${id}"><name>${xml(asset.name)}</name><pathurl>${xml(premiereFileUrl(asset.filePath))}</pathurl>${rateXml(fps)}<duration>${duration}</duration><media>${sample}</media></file>`;
}

function premiereAssetCategory(asset) {
  const requested = String(asset?.category || asset?.kind || 'image').toLowerCase();
  if (requested === 'video') return 'Videos';
  if (requested === 'audio') return 'Audio';
  if (requested === 'drawing' || requested === 'stroke') return 'Drawings';
  return 'Images';
}

function masterClipId(asset) {
  return `masterclip-${String(asset.id)}`;
}

function masterClipXml(asset, fps, emitted) {
  const id = masterClipId(asset);
  const duration = Math.max(1, Number(asset.durationFrames) || 1);
  const still = asset.kind === 'image' ? '<stillframe>TRUE</stillframe>' : '';
  const mediaType = asset.kind === 'audio' ? 'audio' : 'video';
  return `<clip id="${xml(id)}"><name>${xml(asset.name)}</name><duration>${duration}</duration>${rateXml(fps)}<in>0</in><out>${duration}</out><masterclipid>${xml(id)}</masterclipid><ismasterclip>TRUE</ismasterclip>${still}${fileXml(asset, fps, emitted)}<sourcetrack><mediatype>${mediaType}</mediatype></sourcetrack></clip>`;
}

function clipXml(clip, index, fps, width, height, emitted) {
  const id = `clipitem-${xml(clip.id)}-${index}`;
  const still = clip.still ? '<stillframe>TRUE</stillframe>' : '';
  return `<clipitem id="${id}"><name>${xml(clip.name)}</name><enabled>${clip.enabled === false ? 'FALSE' : 'TRUE'}</enabled><duration>${Math.max(1, clip.asset.durationFrames || clip.out)}</duration>${rateXml(fps)}<start>${clip.start}</start><end>${clip.end}</end><in>${clip.in}</in><out>${clip.out}</out><masterclipid>${xml(masterClipId(clip.asset))}</masterclipid>${still}${fileXml(clip.asset, fps, emitted)}${transformXml(clip, width, height)}${volumeXml(clip)}</clipitem>`;
}

function textColor(value) {
  const match = String(value || '').trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  const hex = match ? match[1] : 'ffffff';
  const expanded = hex.length === 3 ? [...hex].map(ch => ch + ch).join('') : hex;
  return {
    red: parseInt(expanded.slice(0, 2), 16),
    green: parseInt(expanded.slice(2, 4), 16),
    blue: parseInt(expanded.slice(4, 6), 16),
  };
}

function textRotationXml(rotation) {
  if (Math.abs(rotation) < 1e-9) return '';
  return `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>rotation</parameterid><name>Rotation</name><valuemin>-8640</valuemin><valuemax>8640</valuemax><value>${rotation.toFixed(6)}</value></parameter></effect></filter>`;
}

function textGeneratorXml(clip, index, fps) {
  const text = clip.text || {};
  const color = textColor(text.color);
  const content = xml(text.content).replace(/\r?\n/g, '&#13;');
  const size = clamp((Number(text.size) || 42) * (Number(text.scale) || 1), 2, 1200);
  // Final Cut's Text generator origin is expressed as a normalized offset
  // from the sequence center. Animatics stores absolute normalized position.
  const x = clamp((Number(text.x) || 0) - .5, -.5, .5);
  const y = clamp((Number(text.y) || 0) - .5, -.5, .5);
  const rotation = clamp(Number(text.rotation) || 0, -180, 180);
  const duration = Math.max(1, clip.out, clip.end - clip.start);
  return `<generatoritem id="generatoritem-${xml(clip.id)}-${index}"><name>${xml(clip.name || 'Text')}</name><duration>${duration}</duration>${rateXml(fps)}<in>${clip.in}</in><out>${clip.out}</out><start>${clip.start}</start><end>${clip.end}</end><enabled>TRUE</enabled><anamorphic>FALSE</anamorphic><alphatype>black</alphatype><effect><name>Text</name><effectid>Text</effectid><effectcategory>Text</effectcategory><effecttype>generator</effecttype><mediatype>video</mediatype><parameter><parameterid>str</parameterid><name>Text</name><value>${content}</value></parameter><parameter><parameterid>fontname</parameterid><name>Font</name><value>Segoe UI</value></parameter><parameter><parameterid>fontsize</parameterid><name>Size</name><valuemin>0</valuemin><valuemax>1200</valuemax><value>${size.toFixed(6)}</value></parameter><parameter><parameterid>fontstyle</parameterid><name>Style</name><valuemin>1</valuemin><valuemax>4</valuemax><value>2</value></parameter><parameter><parameterid>fontalign</parameterid><name>Alignment</name><valuemin>1</valuemin><valuemax>3</valuemax><value>2</value></parameter><parameter><parameterid>fontcolor</parameterid><name>Font Color</name><value><alpha>255</alpha><red>${color.red}</red><green>${color.green}</green><blue>${color.blue}</blue></value></parameter><parameter><parameterid>origin</parameterid><name>Origin</name><value><horiz>${x.toFixed(6)}</horiz><vert>${y.toFixed(6)}</vert></value></parameter></effect>${textRotationXml(rotation)}<sourcetrack><mediatype>video</mediatype></sourcetrack></generatoritem>`;
}

export function createPremiereXml(sequence) {
  const { name = 'RefBoard Animatic', fps = 30, width = 1920, height = 1080, durationFrames = 1 } = sequence;
  const emitted = new Set();
  const assets = new Map();
  for (const track of [...sequence.videoTracks, ...sequence.audioTracks]) {
    for (const clip of track) if (clip.asset && !assets.has(clip.asset.id)) assets.set(clip.asset.id, clip.asset);
  }
  const categoryOrder = ['Images', 'Videos', 'Audio', 'Drawings'];
  const mediaBins = categoryOrder.map(category => {
    const entries = [...assets.values()].filter(asset => premiereAssetCategory(asset) === category);
    return entries.length ? `<bin><name>${category}</name><children>${entries.map(asset => masterClipXml(asset, fps, emitted)).join('')}</children></bin>` : '';
  }).join('');
  let clipIndex = 0;
  const video = sequence.videoTracks.map((track, index) => `<track>${track.map(clip => clip.kind === 'text' ? textGeneratorXml(clip, ++clipIndex, fps) : clipXml(clip, ++clipIndex, fps, width, height, emitted)).join('')}<enabled>${sequence.videoTrackEnabled?.[index] === false ? 'FALSE' : 'TRUE'}</enabled><locked>FALSE</locked></track>`).join('');
  const audio = sequence.audioTracks.map(track => `<track>${track.map(clip => clipXml(clip, ++clipIndex, fps, width, height, emitted)).join('')}<enabled>TRUE</enabled><locked>FALSE</locked></track>`).join('');
  const sequenceXml = `<sequence id="sequence-1"><name>${xml(name)}</name><duration>${durationFrames}</duration>${rateXml(fps)}<timecode>${rateXml(fps)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media><video><format><samplecharacteristics>${rateXml(fps)}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance><colordepth>24</colordepth></samplecharacteristics></format>${video}</video><audio><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format><outputs><group><index>1</index><numchannels>2</numchannels><downmix>0</downmix><channel><index>1</index></channel><channel><index>2</index></channel></group></outputs>${audio}</audio></media></sequence>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><project><name>${xml(name)}</name><children>${mediaBins}<bin><name>Sequences</name><children>${sequenceXml}</children></bin></children></project></xmeml>`;
}
