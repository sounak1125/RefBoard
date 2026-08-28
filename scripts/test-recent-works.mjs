/**
 * Recents keep a history; pins keep the boards someone lives in.
 *
 * The rule that matters: a pinned board survives no matter how much has been
 * opened since, and pinning one never costs an ordinary recent its place.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MAX_PINNED,
  MAX_RECENT,
  capRecentWorks,
  isPinned,
  pinsRemaining,
  sortRecentWorks,
} = require('./recent-works.js');

const board = (name, extra = {}) => ({ id: name, path: `C:/B/${name}.refboard`, title: name, ...extra });
const names = result => result.map(entry => entry.title);

// --- a short list is left alone ---
{
  const list = [board('a'), board('b'), board('c')];
  const { kept, dropped } = capRecentWorks(list);
  assert.deepEqual(names(kept), ['a', 'b', 'c']);
  assert.deepEqual(dropped, []);
}

// --- an unpinned tail falls off at the cap ---
{
  const list = Array.from({ length: MAX_RECENT + 5 }, (_, i) => board(`b${i}`));
  const { kept, dropped } = capRecentWorks(list);
  assert.equal(kept.length, MAX_RECENT, 'the recent slots are the cap');
  assert.equal(dropped.length, 5, 'everything past the cap is dropped');
  assert.equal(dropped[0].title, `b${MAX_RECENT}`, 'the oldest go first');
}

// --- a pinned board survives however much is opened after it ---
{
  const list = [
    ...Array.from({ length: MAX_RECENT + 10 }, (_, i) => board(`new${i}`)),
    board('kept', { pinned: true }),
  ];
  const { kept, dropped } = capRecentWorks(list);
  assert.ok(names(kept).includes('kept'), 'a pin must outlive the cap');
  assert.ok(!names(dropped).includes('kept'), 'a pin is never dropped');
}

// --- pins are kept in addition to the recent slots, not instead of them ---
{
  const list = [
    board('pin1', { pinned: true }),
    board('pin2', { pinned: true }),
    ...Array.from({ length: MAX_RECENT }, (_, i) => board(`r${i}`)),
  ];
  const { kept, dropped } = capRecentWorks(list);
  assert.equal(kept.length, MAX_RECENT + 2, 'pinning must not cost a recent its slot');
  assert.deepEqual(dropped, [], 'nothing is dropped while the recents still fit');
}

// --- past the pin limit, a pin is demoted rather than discarded ---
{
  const list = Array.from({ length: MAX_PINNED + 3 }, (_, i) => board(`p${i}`, { pinned: true }));
  const { kept, dropped } = capRecentWorks(list);
  assert.equal(kept.length, MAX_PINNED + 3, 'a surplus pin still competes for a recent slot');
  assert.deepEqual(dropped, [], 'losing a pin must not lose the board');
  assert.equal(kept.filter(isPinned).length, MAX_PINNED, 'the pin limit holds');
  assert.equal(kept[MAX_PINNED].pinned, false, 'the surplus is demoted, not left claiming a pin');
}

// --- a demoted pin does not mutate the caller's entry ---
{
  const original = board('p', { pinned: true });
  const list = [
    ...Array.from({ length: MAX_PINNED }, (_, i) => board(`q${i}`, { pinned: true })),
    original,
  ];
  capRecentWorks(list);
  assert.equal(original.pinned, true, 'capping must not edit the list it was handed');
}

// --- display order puts pins first, each group still newest-first ---
{
  const sorted = sortRecentWorks([
    board('newest'),
    board('pinnedOld', { pinned: true }),
    board('older'),
    board('pinnedNewer', { pinned: true }),
  ]);
  assert.deepEqual(names(sorted), ['pinnedOld', 'pinnedNewer', 'newest', 'older'],
    'pins lead, and neither group is reshuffled');
}

// --- the remaining-pin count drives what the UI is allowed to offer ---
{
  assert.equal(pinsRemaining([]), MAX_PINNED);
  assert.equal(pinsRemaining([board('a', { pinned: true }), board('b')]), MAX_PINNED - 1);
  assert.equal(
    pinsRemaining(Array.from({ length: MAX_PINNED + 4 }, (_, i) => board(`p${i}`, { pinned: true }))),
    0,
    'never negative, however many pins are already stored');
}

// --- junk in the store does not take the landing page down with it ---
{
  const { kept } = capRecentWorks([null, board('real'), undefined]);
  assert.deepEqual(names(kept), ['real']);
  assert.deepEqual(capRecentWorks(null).kept, []);
  assert.deepEqual(sortRecentWorks(undefined), []);
}

console.log('recent works pinning tests passed');
