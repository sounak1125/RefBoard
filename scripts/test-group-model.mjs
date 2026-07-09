/**
 * Lightweight regression checks for the grouping data model helpers.
 * Run: node scripts/test-group-model.mjs
 */

const GROUP_DEFAULT_PADDING = 20;
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
      padding: Math.min(120, Math.max(4, Number(it.padding) || GROUP_DEFAULT_PADDING)),
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
  const pad = group.padding ?? GROUP_DEFAULT_PADDING;
  if (!kids.length) return;
  const bb = bboxOf(kids);
  group.x = bb.x - pad;
  group.y = bb.y - pad;
  group.w = bb.w + pad * 2;
  group.h = bb.h + pad * 2;
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
assert(group.w === 220 + 40 && group.h === 80 + 40, `syncGroupFrame bbox: got ${group.w}x${group.h}`);
assert(group.x === -20 && group.y === -20, 'syncGroupFrame origin');
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

console.log('All grouping model checks passed.');
