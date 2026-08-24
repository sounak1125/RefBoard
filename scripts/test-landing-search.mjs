/**
 * Home search: a user with dozens of boards has to be able to find one by name
 * or by the folder it lives in, and the filter has to narrow as tokens are
 * added rather than widen.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  boardQueryTokens,
  boardSearchHaystack,
  filterRecentWorks,
  highlightSegments,
  matchesBoardQuery,
  normalizeBoardQuery,
} from './landing-search.mjs';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

/* ---------- query parsing ---------- */

assert.equal(normalizeBoardQuery('  Trip   Moodboard '), 'trip moodboard', 'runs of whitespace collapse to one token break');
assert.equal(normalizeBoardQuery(null), '');
assert.deepEqual(boardQueryTokens('  '), [], 'a blank query has no tokens, so nothing is filtered');
assert.deepEqual(boardQueryTokens('Trip 2024'), ['trip', '2024']);

/* ---------- matching ---------- */

const boards = [
  { title: 'Trip moodboard', path: 'C:\\Users\\me\\Boards\\Travel\\Trip moodboard.refboard' },
  { title: 'Kitchen refs', path: 'C:\\Users\\me\\Boards\\Interiors\\Kitchen refs.refboard' },
  { title: 'Trip 2024', path: 'C:\\Users\\me\\Boards\\Travel\\Trip 2024.refboard' },
  { title: 'Character sheet', path: 'C:\\Clients\\Acme\\Character sheet.refboard' },
];

assert.deepEqual(
  filterRecentWorks(boards, 'trip').map(b => b.title),
  ['Trip moodboard', 'Trip 2024'],
  'matching is case-insensitive',
);
assert.deepEqual(
  filterRecentWorks(boards, 'trip 2024').map(b => b.title),
  ['Trip 2024'],
  'a second token must narrow the result, not add to it',
);
assert.deepEqual(
  filterRecentWorks(boards, 'travel').map(b => b.title),
  ['Trip moodboard', 'Trip 2024'],
  'a folder name is searchable even though it is never shown on the card',
);
assert.deepEqual(
  filterRecentWorks(boards, 'acme character').map(b => b.title),
  ['Character sheet'],
  'tokens may come from the path and the title in any order',
);
assert.equal(filterRecentWorks(boards, 'nothing here').length, 0);
assert.equal(filterRecentWorks(boards, '   ').length, boards.length, 'a blank query shows everything');
assert.equal(filterRecentWorks(null, 'trip').length, 0, 'a missing list must not throw');

assert.ok(
  boardSearchHaystack(boards[0]).includes('travel'),
  'path separators become word breaks so a folder can be typed without a slash',
);
assert.equal(matchesBoardQuery(boards[0], []), true, 'no tokens means no filtering');
assert.equal(matchesBoardQuery({ title: 'Untitled' }, ['untitled']), true, 'an entry with no path still matches on title');

/* ---------- highlighting ---------- */

assert.deepEqual(
  highlightSegments('Trip moodboard', 'trip'),
  [{ text: 'Trip', hit: true }, { text: ' moodboard', hit: false }],
  'the matched run is reported with its original casing',
);
assert.deepEqual(highlightSegments('Trip moodboard', ''), [{ text: 'Trip moodboard', hit: false }]);
assert.deepEqual(highlightSegments('', 'trip'), [{ text: '', hit: false }]);
assert.deepEqual(
  highlightSegments('aaa', 'a a'),
  [{ text: 'aaa', hit: true }],
  'overlapping token hits merge into one run instead of splitting mid-match',
);
assert.equal(
  highlightSegments('Trip 2024 trip', 'trip').filter(s => s.hit).length,
  2,
  'every occurrence is marked, not only the first',
);
assert.equal(
  highlightSegments('Kitchen refs', 'trip').map(s => s.text).join(''),
  'Kitchen refs',
  'segments always reassemble into the original text',
);

/* ---------- wiring ---------- */

assert.match(html, /id="rwSearchInput"/, 'Home needs a search field');
assert.match(html, /class="rw-search-icon"/, 'the search field needs its magnifier icon');
assert.match(
  html,
  /const list = searching \? filterRecentWorks\(all, query\) : all;/,
  'both Home layouts must render from the same filtered source',
);
assert.match(
  html,
  /const showCurrent = hasCurrent && \(!searching \|\| matchesBoardQuery\(/,
  'the in-memory board must be filterable like every other card',
);
assert.match(
  html,
  /noResults\.classList\.toggle\('hide', !\(searching && hasAnyBoards && !hasVisibleBoards\)\)/,
  'an empty search result must not be mistaken for having no boards at all',
);
assert.match(
  html,
  /empty\.classList\.toggle\('hide', hasAnyBoards\)/,
  '"Create your first board" must stay tied to owning no boards, not to the search',
);
assert.match(html, /else if \(mod && k === 'f'\) \{ e\.preventDefault\(\); focusLandingSearch\(\); \}/, 'Ctrl+F on Home must jump to the search field');
assert.match(html, /wireLandingSearch\(\);/, 'the search field must be wired during init');
assert.match(
  html,
  /if \(renderSeq !== recentWorksRenderSeq\) return;[\s\S]{0,340}?cancelCardRename\(\);/,
  'a grid rebuild must discard an open rename instead of stranding its detached field, and a superseded render must not',
);
assert.match(
  html,
  /\.rw-card\.is-renaming \.rw-card-rename,\s*\.rw-card\.is-renaming \.rw-card-clear\{ display:none;/,
  'rename mode must hide the pencil and remove button',
);
assert.match(html, /\.rw-rename-confirm/, 'rename mode must expose a confirm chip');
assert.match(html, /\.rw-rename-cancel/, 'rename mode must expose a cancel chip');
assert.match(
  html,
  /\.rw-rename-confirm:hover[\s\S]*background:#39b26a/,
  'the confirm chip must turn green on hover',
);
assert.match(
  html,
  /\.rw-rename-cancel:hover[\s\S]*background:var\(--danger\)/,
  'the cancel chip must turn red on hover',
);
assert.match(html, /mountRenameActionButtons\(card\)/, 'rename chips must be mounted with the active rename session');

console.log('landing search contract ok');
