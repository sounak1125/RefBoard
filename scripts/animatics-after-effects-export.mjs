const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export const AFTER_EFFECTS_MAX_SECONDS = 3 * 60 * 60;

export function afterEffectsTime(seconds, fps) {
  const rate = Math.max(1, finite(fps, 30));
  return Math.round(Math.max(0, finite(seconds)) * rate) / rate;
}

function mediaKey(item, kind) {
  if (kind === 'image') return `image:${item.itemId}`;
  if (kind === 'video') return `video:${item.mediaId}`;
  if (kind === 'audio') return `audio:${item.mediaId}`;
  return `${kind}:${item.id}`;
}

function colorRgb(value, fallback = '#111827') {
  const match = String(value || fallback).trim().match(/^#([\da-f]{3}|[\da-f]{6})$/i);
  const source = match ? match[1] : fallback.slice(1);
  const hex = source.length === 3 ? [...source].map(ch => ch + ch).join('') : source;
  return [0, 2, 4].map(index => Number((parseInt(hex.slice(index, index + 2), 16) / 255).toFixed(6)));
}

function clippedItem(item, kind, fps, exportStart, exportEnd, asset) {
  const itemStart = Math.max(0, finite(item.start));
  const visibleStart = Math.max(itemStart, exportStart);
  const visibleEnd = Math.min(itemStart + Math.max(0, finite(item.duration)), exportEnd);
  if (visibleEnd <= visibleStart + 1e-9 || (!asset && kind !== 'text')) return null;
  const start = afterEffectsTime(visibleStart - exportStart, fps);
  const end = Math.max(start + 1 / fps, afterEffectsTime(visibleEnd - exportStart, fps));
  const sourceOffset = visibleStart - itemStart;
  const sourceIn = kind === 'video' || kind === 'audio'
    ? afterEffectsTime(finite(item.sourceIn) + sourceOffset, fps)
    : 0;
  return {
    id: String(item.id || `${kind}-${start}`),
    name: String(item.name || asset?.name || (kind === 'text' ? 'Text' : 'Clip')),
    kind,
    track: Math.max(0, Math.round(finite(item.track))),
    start,
    end,
    sourceIn,
    asset,
    enabled: item.enabled !== false,
    linkGroupId: typeof item.linkGroupId === 'string' ? item.linkGroupId : '',
    source: item,
  };
}

function visualTransform(item, asset, width, height) {
  const framing = item.framing || {};
  const sourceWidth = Math.max(1, finite(asset?.width, width));
  const sourceHeight = Math.max(1, finite(asset?.height, height));
  const fit = framing.fit === 'cover'
    ? Math.max(width / sourceWidth, height / sourceHeight)
    : Math.min(width / sourceWidth, height / sourceHeight);
  const scale = fit * clamp(finite(framing.scale, 1), .25, 4) * 100;
  return {
    position: [
      Number((width / 2 + clamp(finite(framing.x), -1, 1) * width / 2).toFixed(6)),
      Number((height / 2 + clamp(finite(framing.y), -1, 1) * height / 2).toFixed(6)),
    ],
    scale: [Number(scale.toFixed(6)), Number(scale.toFixed(6))],
    rotation: 0,
  };
}

function audioDecibels(volume) {
  const level = clamp(finite(volume, 1), 0, 2);
  return level <= 0 ? -192 : Number(clamp(20 * Math.log(level) / Math.LN10, -192, 6.0206).toFixed(6));
}

export function buildAfterEffectsProject({ project, name, fps, width, height, exportStart = 0, exportEnd, assets }) {
  const rate = Math.max(1, finite(fps, 30));
  const compWidth = Math.max(1, Math.round(finite(width, 1920)));
  const compHeight = Math.max(1, Math.round(finite(height, 1080)));
  const sourceEnd = Number.isFinite(Number(exportEnd)) ? Number(exportEnd) : Math.max(0,
    ...(project.clips || []).map(item => finite(item.start) + finite(item.duration)),
    ...(project.texts || []).map(item => finite(item.start) + finite(item.duration)),
    ...(project.audio || []).map(item => finite(item.start) + finite(item.duration)));
  const rangeStart = Math.max(0, finite(exportStart));
  const rangeEnd = Math.max(rangeStart + 1 / rate, sourceEnd);
  if (rangeEnd - rangeStart > AFTER_EFFECTS_MAX_SECONDS + 1e-9) throw new RangeError('After Effects compositions are limited to three hours');
  const duration = Math.max(1 / rate, afterEffectsTime(rangeEnd - rangeStart, rate));
  const lookup = key => assets instanceof Map ? assets.get(key) : assets?.[key];
  const usedAssets = new Map();
  const layers = [];

  const registerAsset = asset => {
    if (!asset) return null;
    const id = String(asset.id || `asset-${usedAssets.size + 1}`);
    const requestedCategory = String(asset.category || asset.kind || 'image').toLowerCase();
    const category = requestedCategory === 'video' ? 'video'
      : requestedCategory === 'audio' ? 'audio'
      : requestedCategory === 'drawing' || requestedCategory === 'stroke' ? 'drawing'
      : 'image';
    if (!usedAssets.has(id)) usedAssets.set(id, {
      id,
      kind: String(asset.kind || 'image'),
      category,
      name: String(asset.name || 'Media'),
      relativePath: String(asset.relativePath || asset.name || 'media.bin').replace(/\\/g, '/'),
    });
    return id;
  };

  const audioItems = [...(project.audio || [])].sort((a, b) => finite(a.track) - finite(b.track) || finite(a.start) - finite(b.start));
  for (const item of audioItems) {
    const entry = clippedItem(item, 'audio', rate, rangeStart, rangeEnd, lookup(mediaKey(item, 'audio')));
    if (!entry) continue;
    layers.push({
      id: entry.id,
      name: entry.name,
      kind: 'audio',
      track: entry.track,
      start: entry.start,
      end: entry.end,
      sourceIn: entry.sourceIn,
      assetId: registerAsset(entry.asset),
      audioDb: audioDecibels(item.volume),
      linkGroupId: entry.linkGroupId,
    });
  }

  const visualItems = [...(project.clips || [])].sort((a, b) => finite(a.track) - finite(b.track) || finite(a.start) - finite(b.start));
  for (const item of visualItems) {
    const kind = item.mediaKind === 'video' ? 'video' : 'image';
    const entry = clippedItem(item, kind, rate, rangeStart, rangeEnd, lookup(mediaKey(item, kind)));
    if (entry) layers.push({
      id: entry.id,
      name: entry.name,
      kind,
      track: entry.track,
      start: entry.start,
      end: entry.end,
      sourceIn: entry.sourceIn,
      enabled: entry.enabled && project.videoTrackEnabled?.[entry.track] !== false,
      assetId: registerAsset(entry.asset),
      transform: visualTransform(item, entry.asset, compWidth, compHeight),
      linkGroupId: entry.linkGroupId,
    });
    const overlay = clippedItem(item, 'overlay', rate, rangeStart, rangeEnd, lookup(`stroke:${item.id}`));
    if (overlay) layers.push({
      id: `stroke-${entry?.id || item.id}`,
      name: overlay.name,
      kind: 'overlay',
      track: overlay.track,
      start: overlay.start,
      end: overlay.end,
      sourceIn: 0,
      enabled: overlay.enabled && project.videoTrackEnabled?.[overlay.track] !== false,
      assetId: registerAsset(overlay.asset),
      transform: { position:[compWidth / 2, compHeight / 2], scale:[100, 100], rotation:0 },
      linkGroupId: overlay.linkGroupId,
    });
  }

  const textItems = [...(project.texts || [])].sort((a, b) => finite(a.start) - finite(b.start));
  for (const item of textItems) {
    const entry = clippedItem(item, 'text', rate, rangeStart, rangeEnd, null);
    if (!entry) continue;
    layers.push({
      id: entry.id,
      name: entry.name,
      kind: 'text',
      track: 0,
      start: entry.start,
      end: entry.end,
      sourceIn: 0,
      text: {
        content: String(item.content ?? ''),
        fontSize: Number((clamp(finite(item.size, 42), 8, 300) * compWidth / 1280).toFixed(6)),
        color: colorRgb(item.color, '#ffffff'),
      },
      transform: {
        position: [
          Number((clamp(finite(item.x, .5), 0, 1) * compWidth).toFixed(6)),
          Number((clamp(finite(item.y, .82), 0, 1) * compHeight).toFixed(6)),
        ],
        scale: [
          Number((clamp(finite(item.scale, 1), .25, 4) * 100).toFixed(6)),
          Number((clamp(finite(item.scale, 1), .25, 4) * 100).toFixed(6)),
        ],
        rotation: Number(clamp(finite(item.rotation), -180, 180).toFixed(6)),
      },
      linkGroupId: '',
    });
  }

  return {
    name: String(name || 'RefBoard Animatic'),
    fps: rate,
    width: compWidth,
    height: compHeight,
    duration,
    background: colorRgb(project.background, '#111827'),
    assets: [...usedAssets.values()],
    layers,
  };
}

function jsxData(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function createAfterEffectsScript(project, { mediaFolderName, projectFileName } = {}) {
  const data = {
    ...project,
    mediaFolderName: String(mediaFolderName || 'RefBoard_Animatic_Media'),
    projectFileName: String(projectFileName || 'RefBoard Animatic.aep'),
  };
  return `#target aftereffects
// RefBoard After Effects Project Builder
(function () {
  var data = ${jsxData(data)};
  function setTransform(layer, transform) {
    if (!transform) return;
    var group = layer.property("ADBE Transform Group");
    group.property("ADBE Position").setValue(transform.position);
    group.property("ADBE Scale").setValue(transform.scale);
    group.property("ADBE Rotate Z").setValue(transform.rotation || 0);
  }
  function makeTextLayer(comp, spec) {
    var layer = comp.layers.addText(spec.text.content);
    var textProperty = layer.property("ADBE Text Properties").property("ADBE Text Document");
    var documentValue = textProperty.value;
    documentValue.text = spec.text.content;
    documentValue.fontSize = spec.text.fontSize;
    documentValue.applyFill = true;
    documentValue.fillColor = spec.text.color;
    documentValue.applyStroke = false;
    documentValue.justification = ParagraphJustification.CENTER_JUSTIFY;
    textProperty.setValue(documentValue);
    var bounds = layer.sourceRectAtTime(spec.start, false);
    layer.property("ADBE Transform Group").property("ADBE Anchor Point").setValue([bounds.left + bounds.width / 2, bounds.top + bounds.height / 2]);
    return layer;
  }
  function prepareNewProject() {
    if (app.project && app.project.numItems > 0) {
      if (!confirm("RefBoard will create a new After Effects project. Save your current project before continuing.")) return false;
      if (!app.newProject()) return false;
    } else if (!app.project) {
      app.newProject();
    }
    return true;
  }
  if (!prepareNewProject()) return;
  app.beginUndoGroup("Build RefBoard Animatic");
  try {
    var exportRoot = new File($.fileName).parent;
    var mediaDirectory = new Folder(exportRoot.fsName + "/" + data.mediaFolderName);
    if (!mediaDirectory.exists) throw new Error("Collected media folder is missing: " + mediaDirectory.fsName);
    var projectRoot = app.project.items.addFolder("RefBoard Animatic");
    var compositionsBin = app.project.items.addFolder("Compositions");
    compositionsBin.parentFolder = projectRoot;
    var mediaBin = app.project.items.addFolder("RefBoard Media");
    mediaBin.parentFolder = projectRoot;
    var categoryBins = {};
    var categoryNames = { image:"Images", video:"Videos", audio:"Audio", drawing:"Drawings" };
    var imported = {};
    var index;
    for (index = 0; index < data.assets.length; index++) {
      var asset = data.assets[index];
      if (!categoryBins[asset.category]) {
        categoryBins[asset.category] = app.project.items.addFolder(categoryNames[asset.category] || "Other");
        categoryBins[asset.category].parentFolder = mediaBin;
      }
      var sourceFile = new File(mediaDirectory.fsName + "/" + asset.relativePath);
      if (!sourceFile.exists) throw new Error("Missing media: " + sourceFile.fsName);
      var footage = app.project.importFile(new ImportOptions(sourceFile));
      footage.name = asset.name;
      footage.parentFolder = categoryBins[asset.category];
      imported[asset.id] = footage;
    }
    var comp = app.project.items.addComp(data.name, data.width, data.height, 1, data.duration, data.fps);
    comp.parentFolder = compositionsBin;
    comp.bgColor = data.background;
    comp.workAreaStart = 0;
    comp.workAreaDuration = data.duration;
    for (index = 0; index < data.layers.length; index++) {
      var spec = data.layers[index];
      var layer = spec.kind === "text" ? makeTextLayer(comp, spec) : comp.layers.add(imported[spec.assetId]);
      layer.name = spec.name;
      layer.enabled = spec.enabled !== false;
      layer.startTime = spec.kind === "video" || spec.kind === "audio" ? spec.start - spec.sourceIn : spec.start;
      layer.inPoint = spec.start;
      layer.outPoint = spec.end;
      if (spec.linkGroupId) layer.comment = "RefBoard linked group: " + spec.linkGroupId;
      setTransform(layer, spec.transform);
      if (spec.kind === "audio") {
        var audioGroup = layer.property("ADBE Audio Group");
        var audioLevels = audioGroup && audioGroup.property("ADBE Audio Levels");
        if (audioLevels) audioLevels.setValue([spec.audioDb, spec.audioDb]);
      }
    }
    comp.openInViewer();
    var projectFile = new File(exportRoot.fsName + "/" + data.projectFileName);
    app.project.save(projectFile);
    alert("RefBoard After Effects project created:\\n" + projectFile.fsName);
  } catch (error) {
    alert("RefBoard After Effects export failed:\\n" + error.toString());
    throw error;
  } finally {
    app.endUndoGroup();
  }
})();
`;
}
