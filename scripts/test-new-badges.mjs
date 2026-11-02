#!/usr/bin/env node
/**
 * "New" badges: which badges a launch shows (scripts/new-badges.js), and that
 * every badge a release note asks for has a control in index.html to sit on.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import newBadges from './new-badges.js';

const { BADGE_ID, badgesBetween, pendingBadges, storeAfterLaunch, withoutBadge } = newBadges;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFileSync(path.join(root, name), 'utf8').replace(/\r\n/g, '\n');
const ids = list => list.map(badge => badge.id);

const item = (title, badge) => ({ title, description: `${title} in one line.`, ...(badge ? { badge } : {}) });
const release = (added, improved = [], fixed = []) => ({ headline: 'h', summary: 's', sections: { new: added, improved, fixed } });
const changelog = {
  '2.2.0': release([item('Remove object', 'remove-object'), item('No control to point at')]),
  '2.2.1': release([], [], [item('A fix')]),
  '2.3.0': release([item('Compare', 'compare')], [item('Remove object, faster', 'remove-object')]),
  '2.3.1': release([], [], [item('Another fix')]),
  '2.4.0': release([], [item('Smoother zoom')]),
};
const waiting = [{ id: 'compare', title: 'Compare', description: 'Compare in one line.' }];

/* Which releases count, and whose words a badge uses. */
assert.deepEqual(badgesBetween(changelog, '2.1.6', '2.2.0'),
  [{ id: 'remove-object', title: 'Remove object', description: 'Remove object in one line.' }],
  'a badge carries its note\'s title and description');
assert.deepEqual(ids(badgesBetween(changelog, '2.1.6', '2.3.0')), ['compare', 'remove-object'], 'every release after the old version, up to this one');
assert.equal(badgesBetween(changelog, '2.1.6', '2.3.0')[1].title, 'Remove object, faster', 'the newer note for a control wins');
assert.deepEqual(badgesBetween(changelog, '2.2.0', '2.2.1'), [], 'a fixes-only update brings none');
assert.deepEqual(badgesBetween(changelog, '2.3.0', '2.3.0'), [], 'nothing is newer than the version itself');

/* What a launch does to the store. */
assert.deepEqual(storeAfterLaunch({}, changelog, '2.3.0'), { lastRunVersion: '2.3.0', badges: [] },
  'a first install gets no badges: everything is new to it');
assert.equal(storeAfterLaunch({ lastRunVersion: '2.3.0', badges: waiting }, changelog, '2.3.0'), null,
  'a second launch of the same version changes nothing');
assert.deepEqual(storeAfterLaunch({ lastSeenVersion: '2.1.6' }, changelog, '2.2.0'),
  { lastSeenVersion: '2.1.6', lastRunVersion: '2.2.0', badges: badgesBetween(changelog, '2.1.6', '2.2.0') },
  'from a version before badges, the last What\'s New seen stands in for the last version run');
assert.deepEqual(ids(storeAfterLaunch({ lastRunVersion: '2.1.6' }, changelog, '2.3.1').badges), ['compare', 'remove-object'],
  'skipped updates bring all their badges');
assert.deepEqual(storeAfterLaunch({ lastRunVersion: '2.3.0', badges: waiting }, changelog, '2.3.1').badges, waiting,
  'a fixes-only update keeps the badges still waiting');
assert.deepEqual(storeAfterLaunch({ lastRunVersion: '2.3.1', badges: waiting }, changelog, '2.4.0').badges, [],
  'a new minor version retires them even with no badges of its own');
assert.deepEqual(ids(storeAfterLaunch({ lastRunVersion: '2.2.1', badges: [{ id: 'old-thing', title: 'Old' }] }, changelog, '2.3.0').badges),
  ['compare', 'remove-object'], 'an update with badges replaces the ones waiting');
assert.deepEqual(storeAfterLaunch({ lastRunVersion: '2.4.0', badges: waiting }, changelog, '2.3.0').badges, [],
  'going back to an older version shows none');
assert.equal(storeAfterLaunch({ lastSeenVersion: '2.2.0', lastRunVersion: '2.2.0', other: 1 }, changelog, '2.3.0').other, 1,
  'every other key in the store survives');
assert.equal(storeAfterLaunch({}, changelog, 'not-a-version'), null, 'a version it cannot read changes nothing');

/* Seeing a badge. */
const store = storeAfterLaunch({ lastRunVersion: '2.2.1' }, changelog, '2.3.0');
const seen = withoutBadge(store, 'compare');
assert.deepEqual(ids(seen.badges), ['remove-object'], 'Got it removes that badge only');
assert.equal(seen.lastRunVersion, '2.3.0', 'and keeps the rest of the store');
assert.equal(withoutBadge(seen, 'compare'), null, 'seeing it twice changes nothing');
assert.deepEqual(ids(pendingBadges({ badges: [
  { id: 'ok-one', title: 'Kept' }, { id: 'Bad Id', title: 'x' }, { id: 'no-title' }, null, { id: 'ok-one', title: 'Twice' },
] })), ['ok-one'], 'a damaged store keeps only well-formed badges, once each');
assert.deepEqual(pendingBadges({ badges: 'nope' }), [], 'a store without a list has none');

/* Every badge a release note asks for needs a control: a data-badge attribute,
   or a badge: '<id>' on a right-click menu entry. */
function controlIds(html) {
  return new Set([
    ...[...html.matchAll(/\bdata-badge="([^"]*)"/g)].map(match => match[1]),
    ...[...html.matchAll(/\bbadge: '([^']*)'/g)].map(match => match[1]),
  ]);
}
function notedBadges(entries) {
  const noted = new Map();
  for (const [label, entry] of entries) {
    for (const key of ['new', 'improved', 'fixed']) {
      for (const note of entry?.sections?.[key] || []) if (note?.badge && !noted.has(note.badge)) noted.set(note.badge, label);
    }
  }
  return noted;
}
function controlsMissing(html, noted) {
  const controls = controlIds(html);
  return [...noted].filter(([id]) => !controls.has(id)).map(([id, label]) => `${label} gives "${id}" a badge, but no control in index.html has that id`);
}

const html = read('index.html');
const realChangelog = JSON.parse(read('changelog.json'));
const noted = notedBadges([...Object.entries(realChangelog), ['release-highlights.json', JSON.parse(read('release-highlights.json'))]]);
for (const id of controlIds(html)) assert.match(id, BADGE_ID, `index.html has a badge id "${id}" that no release note could name`);
assert.deepEqual(controlsMissing(html, noted), []);
// The check has to catch the mistake it exists for.
assert.deepEqual(controlsMissing(html.replace('data-badge="label-align"', ''), noted),
  [`2.2.0 gives "label-align" a badge, but no control in index.html has that id`], 'a note pointing at a missing control fails');
// Menu items are found by label, so every label in the table must be a real one.
const menuTable = html.slice(html.indexOf('const MENU_ITEM_BADGES = {'), html.indexOf('};', html.indexOf('const MENU_ITEM_BADGES = {')));
const menuLabels = [...menuTable.matchAll(/^ {2}'([^']+)': \{/gm)].map(match => match[1]);
assert(menuLabels.length >= 6, 'the right-click menu badges are listed');
for (const label of menuLabels) assert(html.includes(`l: '${label}'`), `MENU_ITEM_BADGES names "${label}", which no right-click menu item is called`);
assert.deepEqual(ids(badgesBetween(realChangelog, '2.1.6', '2.2.0')), ['remove-object', 'line-up-rows', 'label-align'],
  'someone coming from 2.1.6 gets 2.2.0\'s three badges');

/* main.js keeps the store whole: dismissing What's New must not drop the badges. */
const main = read('main.js');
assert.match(main, /require\('\.\/scripts\/new-badges'\)/, 'main.js uses the badge rules');
assert.doesNotMatch(main, /saveWhatsNewStore\(\{\s*lastSeenVersion/, 'dismissing What\'s New must not rewrite the store from scratch');

console.log(`new badges ok - launch rules, Got it, and ${noted.size} noted badges all have a control`);
