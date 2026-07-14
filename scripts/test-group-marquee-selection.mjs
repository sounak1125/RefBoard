import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  const brace = html.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(`${name} should have a complete body`);
}

const items = [
  { id: 'g1', kind: 'group' },
  { id: 'g1-a', kind: 'image', groupId: 'g1', x: 10, y: 10, w: 40, h: 30 },
  { id: 'g1-b', kind: 'note', groupId: 'g1', x: 60, y: 10, w: 30, h: 30 },
  { id: 'g2', kind: 'group', locked: true },
  { id: 'g2-a', kind: 'image', groupId: 'g2', x: 120, y: 20, w: 30, h: 30 },
  { id: 'g2-b', kind: 'image', groupId: 'g2', x: 160, y: 20, w: 30, h: 30 },
  { id: 'free', kind: 'image', x: 220, y: 20, w: 30, h: 30 },
];

const byId = id => items.find(item => item.id === id);
const context = {
  state: { items },
  byId,
  isGroupItem: item => item?.kind === 'group',
  isGroupableItem: item => item?.kind === 'image' || item?.kind === 'note',
  groupItems: () => items.filter(item => item.kind === 'group'),
  childrenOfGroup: gid => items.filter(item => item.groupId === gid),
  groupOfItem: item => item?.groupId ? byId(item.groupId) : null,
  boundsOf: item => ({ x: item.x, y: item.y, w: item.w, h: item.h }),
  effectiveHitItem: item => item,
  Set,
};
vm.runInNewContext(`${extractFunction('marqueeSelectionIds')}; this.marqueeSelectionIds = marqueeSelectionIds;`, context);

const ids = value => [...value].sort();

assert.deepEqual(
  ids(context.marqueeSelectionIds(0, 0, 100, 50)),
  ['g1'],
  'fully enclosing all children should select the group root once',
);

assert.deepEqual(
  ids(context.marqueeSelectionIds(0, 0, 55, 50)),
  ['g1'],
  'touching one child should promote the marquee selection to its group',
);

assert.deepEqual(
  ids(context.marqueeSelectionIds(0, 0, 200, 60)),
  ['g1', 'g2'],
  'multiple fully enclosed groups should each be promoted and deduplicated',
);

assert.deepEqual(
  ids(context.marqueeSelectionIds(110, 0, 155, 60)),
  ['g2'],
  'touching one child of a locked group should select its group root',
);

assert.deepEqual(
  ids(context.marqueeSelectionIds(110, 0, 200, 60)),
  ['g2'],
  'fully enclosing a locked group should select its group root',
);

assert.deepEqual(
  ids(context.marqueeSelectionIds(210, 0, 260, 60, new Set(['g1-a']))),
  ['free', 'g1-a'],
  'Shift-marquee should retain an existing child when its group is not touched',
);

assert.deepEqual(
  ids(context.marqueeSelectionIds(55, 0, 95, 50, new Set(['g1-a', 'free']))),
  ['free', 'g1'],
  'touching another child should replace kept child IDs with the group root',
);

assert.deepEqual(
  ids(context.marqueeSelectionIds(0, 0, 100, 50, new Set(['g1-a', 'free']))),
  ['free', 'g1'],
  'full group promotion should replace kept child IDs while preserving unrelated selections',
);

assert.deepEqual(
  ids(context.marqueeSelectionIds(55, 0, 95, 50, new Set(['g1']))),
  ['g1'],
  'a kept group should remain atomic when Shift-marquee crosses one child',
);

assert.match(
  html,
  /state\.sel = marqueeSelectionIds\(bx1, by1, bx2, by2, mode\.keep\)/,
  'the live marquee path should use the group-aware resolver',
);

console.log('group marquee selection tests passed');
