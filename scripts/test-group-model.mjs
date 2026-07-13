/**
 * Lightweight regression checks for the grouping data model helpers.
 * Run: node scripts/test-group-model.mjs
 */

const GROUP_MIN_PADDING = 40;
const GROUP_DEFAULT_PADDING = GROUP_MIN_PADDING;
const GROUP_CORNER_RADIUS_PX = 12;
const GROUP_SCREEN_PADDING_PX = 16;
const GROUP_CHROME_FULL_SIZE_ZOOM = 0.01;
const GROUP_LABEL_GAP_PX = 6;
const GROUP_LABEL_SIZE_PX = 13;
const GROUP_DEFAULT_COLOR = '#5aa2ff';
const GROUP_NAME_MAX = 48;

function sanitizeGroupName(raw) {
  return String(raw || '').replace(/[\r\n]+/g, ' ').trim().slice(0, GROUP_NAME_MAX);
}
const isImageItem = it => (it.kind || 'image') === 'image';
const isNoteItem = it => it.kind === 'note';
const isGroupItem = it => it.kind === 'group';
const isGroupableItem = it => isImageItem(it) || isNoteItem(it);

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function parseHexColor(hex) {
  let h = String(hex || '').trim();
  if (!h) return null;
  if (!h.startsWith('#')) h = '#' + h;
  let raw = h.slice(1);
  if (raw.length === 3) raw = raw.split('').map(c => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) return null;
  return {
    r: parseInt(raw.slice(0, 2), 16),
    g: parseInt(raw.slice(2, 4), 16),
    b: parseInt(raw.slice(4, 6), 16),
  };
}

function rgbToHexColor(r, g, b) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

function normalizeGroupColor(hex) {
  const parsed = parseHexColor(hex);
  return parsed ? rgbToHexColor(parsed.r, parsed.g, parsed.b) : GROUP_DEFAULT_COLOR;
}

function normalizeItem(it) {
  if (it.kind === 'group') {
    return {
      id: it.id || uid(), kind: 'group',
      x: Number(it.x) || 0, y: Number(it.y) || 0,
      w: Math.max(20, Number(it.w) || 100), h: Math.max(20, Number(it.h) || 100),
      rot: Number(it.rot) || 0,
      padding: Math.min(120, Math.max(GROUP_MIN_PADDING, Number(it.padding) || GROUP_DEFAULT_PADDING)),
      color: normalizeGroupColor(it.color || GROUP_DEFAULT_COLOR),
      locked: !!it.locked,
      name: sanitizeGroupName(it.name),
    };
  }
  if (it.kind === 'note') {
    return {
      id: it.id || uid(), kind: 'note',
      x: Number(it.x) || 0, y: Number(it.y) || 0,
      w: Math.max(20, Number(it.w) || 100), h: Math.max(20, Number(it.h) || 100),
      groupId: it.groupId || null,
    };
  }
  return {
    id: it.id || uid(), kind: 'image', imgId: it.imgId,
    x: Number(it.x) || 0, y: Number(it.y) || 0,
    w: Math.max(20, Number(it.w) || 100), h: Math.max(20, Number(it.h) || 100),
    groupId: it.groupId || null,
  };
}

function bboxOf(items) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const it of items) {
    x1 = Math.min(x1, it.x); y1 = Math.min(y1, it.y);
    x2 = Math.max(x2, it.x + it.w); y2 = Math.max(y2, it.y + it.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function childrenOfGroup(state, gid) {
  return state.items.filter(i => i.groupId === gid);
}

function syncGroupFrame(state, group) {
  const kids = childrenOfGroup(state, group.id);
  const pad = Math.min(120, Math.max(GROUP_MIN_PADDING, Number(group.padding) || GROUP_DEFAULT_PADDING));
  if (!kids.length) return;
  const bb = bboxOf(kids);
  group.x = bb.x - pad;
  group.y = bb.y - pad;
  group.w = bb.w + pad * 2;
  group.h = bb.h + pad * 2;
}

function groupFrameHit(group, sx, sy, scale) {
  const x1 = group.x * scale, y1 = group.y * scale;
  const x2 = (group.x + group.w) * scale, y2 = (group.y + group.h) * scale;
  const w = x2 - x1, h = y2 - y1;
  const hitPx = 10;
  const inward = Math.min(hitPx, Math.min(w, h) * 0.2);
  const inOuter = sx >= x1 - hitPx && sx <= x2 + hitPx
    && sy >= y1 - hitPx && sy <= y2 + hitPx;
  const inInner = sx > x1 + inward && sx < x2 - inward
    && sy > y1 + inward && sy < y2 - inward;
  return inOuter && !inInner;
}

function groupUiRectAtScale(kidsBox, scale) {
  const pad = GROUP_SCREEN_PADDING_PX / Math.max(scale, GROUP_CHROME_FULL_SIZE_ZOOM);
  return {
    x: kidsBox.x - pad,
    y: kidsBox.y - pad,
    w: kidsBox.w + pad * 2,
    h: kidsBox.h + pad * 2,
  };
}

function reconcileGroupOrder(state) {
  const groups = state.items.filter(isGroupItem);
  const rest = state.items.filter(i => !isGroupItem(i));
  const ordered = [];
  const placed = new Set();
  for (const g of groups) {
    ordered.push(g);
    placed.add(g.id);
    for (const c of rest.filter(i => i.groupId === g.id)) {
      ordered.push(c);
      placed.add(c.id);
    }
  }
  for (const it of rest) {
    if (!placed.has(it.id)) ordered.push(it);
  }
  state.items = ordered;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// v2 file without groups loads unchanged
const v2 = {
  app: 'refboard', version: 2,
  items: [
    { id: 'a', kind: 'image', imgId: 'img1', x: 0, y: 0, w: 100, h: 80 },
    { id: 'b', kind: 'note', x: 120, y: 0, w: 200, h: 90, text: 'hi' },
  ],
};
const v2Items = v2.items.map(normalizeItem);
assert(v2Items.every(i => i.groupId === null), 'v2 items should have null groupId');
assert(v2Items.every(i => !isGroupItem(i)), 'v2 should have no groups');

// v3 round-trip
const gId = 'grp1';
const v3 = {
  app: 'refboard', version: 3,
  items: [
    { id: gId, kind: 'group', x: -20, y: -20, w: 344, h: 120, padding: 20 },
    { id: 'c1', kind: 'image', imgId: 'img1', x: 0, y: 0, w: 100, h: 80, groupId: gId },
    { id: 'c2', kind: 'image', imgId: 'img2', x: 120, y: 0, w: 100, h: 80, groupId: gId },
  ],
};
const state = { items: v3.items.map(normalizeItem) };
const group = state.items.find(isGroupItem);
syncGroupFrame(state, group);
assert(group.w === 220 + 80 && group.h === 80 + 80, `syncGroupFrame bbox: got ${group.w}x${group.h}`);
assert(group.x === -40 && group.y === -40, 'syncGroupFrame origin');
assert(group.padding === GROUP_MIN_PADDING, 'legacy narrow padding should migrate to the minimum clickable gap');
const groupKidsBox = bboxOf(childrenOfGroup(state, group.id));
assert(groupKidsBox.x - group.x === GROUP_MIN_PADDING, 'group left gap');
assert(groupKidsBox.y - group.y === GROUP_MIN_PADDING, 'group top gap');
assert(group.x + group.w - (groupKidsBox.x + groupKidsBox.w) === GROUP_MIN_PADDING, 'group right gap');
assert(group.y + group.h - (groupKidsBox.y + groupKidsBox.h) === GROUP_MIN_PADDING, 'group bottom gap');
for (const scale of [0.01, 0.05, 0.25, 1, 4, 16, 100]) {
  const ui = groupUiRectAtScale(groupKidsBox, scale);
  const leftGapPx = (groupKidsBox.x - ui.x) * scale;
  const rightGapPx = (ui.x + ui.w - groupKidsBox.x - groupKidsBox.w) * scale;
  const topGapPx = (groupKidsBox.y - ui.y) * scale;
  const bottomGapPx = (ui.y + ui.h - groupKidsBox.y - groupKidsBox.h) * scale;
  const gapStable = [leftGapPx, rightGapPx, topGapPx, bottomGapPx]
    .every(gap => Math.abs(gap - GROUP_SCREEN_PADDING_PX) < 1e-6);
  assert(gapStable,
  `group visual padding should stay stable at ${scale}x zoom`);
  const edgeX = ui.x * scale;
  const midY = (ui.y + ui.h / 2) * scale;
  assert(groupFrameHit(ui, edgeX - 8, midY, scale), `group frame should be clickable at ${scale}x zoom`);
  const centerX = (ui.x + ui.w / 2) * scale;
  assert(!groupFrameHit(ui, centerX, midY, scale), `group center should preserve child hits at ${scale}x zoom`);
  const radiusBoard = Math.min(GROUP_CORNER_RADIUS_PX / scale, ui.w / 2, ui.h / 2);
  const radiusScreen = radiusBoard * scale;
  const maxPossibleRadius = Math.min(ui.w * scale, ui.h * scale) / 2;
  assert(Math.abs(radiusScreen - Math.min(GROUP_CORNER_RADIUS_PX, maxPossibleRadius)) < 1e-6,
    `group corner radius should stay visually stable at ${scale}x zoom`);
}

// At extreme zoom, visual group chrome must shrink with the board rather than
// staying 16px/13px and overwhelming tiny child previews. Hit-testing remains
// screen-sized and independent of this visual scale.
for (const scale of [0.005, 0.004, 0.001, 0.0001]) {
  const ui = groupUiRectAtScale(groupKidsBox, scale);
  const expectedFactor = scale / GROUP_CHROME_FULL_SIZE_ZOOM;
  const expectedPadPx = GROUP_SCREEN_PADDING_PX * expectedFactor;
  const leftGapPx = (groupKidsBox.x - ui.x) * scale;
  const labelPx = GROUP_LABEL_SIZE_PX * expectedFactor;
  const labelGapPx = GROUP_LABEL_GAP_PX * expectedFactor;
  const radiusBoard = Math.min(
    GROUP_CORNER_RADIUS_PX / Math.max(scale, GROUP_CHROME_FULL_SIZE_ZOOM),
    ui.w / 2,
    ui.h / 2,
  );
  assert(Math.abs(leftGapPx - expectedPadPx) < 1e-6,
    `group padding should shrink at ${scale}x zoom`);
  assert(labelPx < GROUP_LABEL_SIZE_PX && labelGapPx < GROUP_LABEL_GAP_PX,
    `group label chrome should shrink at ${scale}x zoom`);
  assert(radiusBoard * scale <= GROUP_CORNER_RADIUS_PX * expectedFactor + 1e-6,
    `group corner radius should shrink at ${scale}x zoom`);
  const edgeX = ui.x * scale;
  const midY = (ui.y + ui.h / 2) * scale;
  assert(groupFrameHit(ui, edgeX - 8, midY, scale),
    `group frame should remain clickable at ${scale}x zoom`);
}
reconcileGroupOrder(state);
const gi = state.items.findIndex(i => i.id === gId);
const c1i = state.items.findIndex(i => i.id === 'c1');
assert(gi < c1i, 'group should appear before children in z-order');

// group color/locked defaults
const bareGroup = normalizeItem({ id: 'g0', kind: 'group', x: 0, y: 0, w: 100, h: 100 });
assert(bareGroup.color === GROUP_DEFAULT_COLOR, 'default group color');
assert(bareGroup.locked === false, 'default group locked false');
const customGroup = normalizeItem({ id: 'g1', kind: 'group', x: 0, y: 0, w: 100, h: 100, color: '#ff0000', locked: true });
assert(customGroup.color === '#ff0000', 'custom group color preserved');
assert(customGroup.locked === true, 'custom group locked preserved');
const legacyGroup = normalizeItem({ id: 'g2', kind: 'group', x: 0, y: 0, w: 100, h: 100 });
assert(legacyGroup.color === GROUP_DEFAULT_COLOR && legacyGroup.locked === false, 'legacy group fields default');
assert(bareGroup.name === '', 'default group name empty');
const namedGroup = normalizeItem({ id: 'g3', kind: 'group', x: 0, y: 0, w: 100, h: 100, name: '  Mood refs\n  ' });
assert(namedGroup.name === 'Mood refs', 'sanitizeGroupName trims and strips newlines');

function buildItemClipboardPayload(testState, roots) {
  const ids = new Set(roots.map(it => it.id));
  for (const it of roots) {
    if (!isGroupItem(it)) continue;
    for (const child of childrenOfGroup(testState, it.id)) ids.add(child.id);
  }
  return {
    app: 'refboard', kind: 'item-clipboard', v: 1,
    selectedIds: roots.map(it => it.id),
    items: testState.items.filter(it => ids.has(it.id)).map(it => structuredClone(it)),
  };
}

function pasteItemsFromClipboard(testState, payload, pos, nextId) {
  const defs = payload.items;
  const ids = new Set(defs.map(it => it.id));
  if (ids.size !== defs.length) return null;
  const groupIds = new Set(defs.filter(isGroupItem).map(it => it.id));
  const idMap = new Map(defs.map(it => [it.id, nextId()]));
  const bb = bboxOf(defs);
  const dx = pos[0] - (bb.x + bb.w / 2);
  const dy = pos[1] - (bb.y + bb.h / 2);
  const clones = defs.map(def => {
    const base = structuredClone(def);
    base.id = idMap.get(def.id);
    base.x = def.x + dx;
    base.y = def.y + dy;
    if (isGroupableItem(def)) {
      base.groupId = def.groupId && groupIds.has(def.groupId) ? idMap.get(def.groupId) : null;
    }
    return normalizeItem(base);
  });
  testState.items.push(...clones);
  reconcileGroupOrder(testState);
  for (const pastedGroup of clones.filter(isGroupItem)) syncGroupFrame(testState, pastedGroup);
  return {
    clones,
    selectedIds: payload.selectedIds.map(id => idMap.get(id)).filter(Boolean),
  };
}

function duplicateGroup(testState, groupId, scale, nextId) {
  const sourceGroup = testState.items.find(it => it.id === groupId && isGroupItem(it));
  const sourceKids = childrenOfGroup(testState, groupId);
  const offset = 26 / scale;
  const newGroupId = nextId();
  const newGroup = normalizeItem({
    ...sourceGroup, id: newGroupId,
    x: sourceGroup.x + offset, y: sourceGroup.y + offset,
  });
  const clones = sourceKids.map(it => normalizeItem({
    ...it, id: nextId(), groupId: newGroupId,
    x: it.x + offset, y: it.y + offset,
  }));
  testState.items.push(newGroup, ...clones);
  reconcileGroupOrder(testState);
  return { newGroup, clones, offset };
}

// Same-board Ctrl+C/Ctrl+V: group metadata and every child travel together,
// IDs are remapped, and repeated paste never reuses a previous clone's IDs.
const clipboardSource = {
  items: [
    normalizeItem({ id: 'copy-g', kind: 'group', x: 0, y: 0, w: 100, h: 100,
      padding: 60, color: '#ff6b6b', locked: true, name: 'Copied refs' }),
    normalizeItem({ id: 'copy-a', kind: 'image', imgId: 'shared-img-a', x: 100, y: 80, w: 320, h: 180, groupId: 'copy-g' }),
    normalizeItem({ id: 'copy-b', kind: 'image', imgId: 'shared-img-b', x: 450, y: 100, w: 200, h: 300, groupId: 'copy-g' }),
  ],
};
syncGroupFrame(clipboardSource, clipboardSource.items[0]);
const clipboardPayload = buildItemClipboardPayload(clipboardSource, [clipboardSource.items[0]]);
assert(clipboardPayload.items.length === 3, 'copying a group should include both children');
assert(clipboardPayload.selectedIds.length === 1 && clipboardPayload.selectedIds[0] === 'copy-g',
  'clipboard should remember the group as the selected root');

const pasteState = { items: clipboardSource.items.map(it => structuredClone(it)) };
let pasteSeq = 0;
const nextPasteId = () => `paste-${++pasteSeq}`;
const firstPaste = pasteItemsFromClipboard(pasteState, clipboardPayload, [1200, 700], nextPasteId);
const firstGroup = firstPaste.clones.find(isGroupItem);
const firstKids = firstPaste.clones.filter(isGroupableItem);
assert(firstPaste.selectedIds.length === 1 && firstPaste.selectedIds[0] === firstGroup.id,
  'pasting a group should select the new group root');
assert(firstKids.length === 2 && firstKids.every(it => it.groupId === firstGroup.id),
  'pasted children should point to the new group ID');
assert(firstKids.map(it => it.imgId).join(',') === 'shared-img-a,shared-img-b',
  'same-board paste should reuse source image records without duplicating pixels');
assert(firstGroup.name === 'Copied refs' && firstGroup.color === '#ff6b6b'
  && firstGroup.locked === true && firstGroup.padding === 60,
  'pasted group should preserve name, color, lock, and padding');

const secondPaste = pasteItemsFromClipboard(pasteState, clipboardPayload, [1600, 900], nextPasteId);
const allIds = pasteState.items.map(it => it.id);
assert(new Set(allIds).size === allIds.length, 'repeated Ctrl+V should always generate unique IDs');
assert(secondPaste.clones.filter(isGroupableItem).every(it =>
  it.groupId === secondPaste.clones.find(isGroupItem).id),
  'repeated paste should remap children to its own new group');
assert(clipboardSource.items.filter(isGroupableItem).every(it => it.groupId === 'copy-g'),
  'copy/paste should not mutate the original group');

// Ctrl+D: clone the complete group at a screen-consistent offset while
// retaining metadata and child membership.
const duplicateState = { items: clipboardSource.items.map(it => structuredClone(it)) };
let duplicateSeq = 0;
const duplicated = duplicateGroup(duplicateState, 'copy-g', 0.25, () => `dup-${++duplicateSeq}`);
assert(duplicated.clones.length === 2 && duplicated.clones.every(it => it.groupId === duplicated.newGroup.id),
  'Ctrl+D should duplicate the full group and remap its children');
assert(duplicated.newGroup.name === 'Copied refs' && duplicated.newGroup.color === '#ff6b6b'
  && duplicated.newGroup.locked === true && duplicated.newGroup.padding === 60,
  'Ctrl+D should preserve group metadata');
assert(duplicated.clones[0].x - clipboardSource.items[1].x === duplicated.offset
  && duplicated.clones[0].y - clipboardSource.items[1].y === duplicated.offset,
  'Ctrl+D should offset group children consistently');
assert(new Set(duplicateState.items.map(it => it.id)).size === duplicateState.items.length,
  'Ctrl+D should generate unique IDs');

console.log('All grouping model checks passed.');
