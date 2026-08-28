/**
 * Tag values and the filter they drive.
 *
 * The rules that matter here are the ones a user would notice: typing the same
 * tag twice in different case must not create two chips, a filter must never
 * strand items behind a tag nothing carries, and an empty filter must show the
 * whole board rather than none of it.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  TAGS_MAX_PER_ITEM,
  TAG_COLOR_PALETTE,
  TAG_MAX_LENGTH,
  addTags,
  collectBoardTags,
  hasTag,
  itemMatchesTags,
  normalizeTag,
  normalizeTagColor,
  normalizeTagColors,
  normalizeTags,
  parseTagInput,
  pruneActiveTags,
  pruneTagColors,
  removeTag,
  suggestTagColor,
  tagGlowColor,
  tagKey,
} from './tags.mjs';

/* ================= one tag ================= */

assert.equal(normalizeTag('  lighting  '), 'lighting', 'surrounding space is not part of the tag');
assert.equal(normalizeTag('warm   rim   light'), 'warm rim light', 'runs of space collapse');
assert.equal(normalizeTag('warm-rim'), 'warm-rim', 'a hyphen is part of the word, not a separator');

// People type the hash out of habit; "#lighting" and "lighting" are one tag.
assert.equal(normalizeTag('#lighting'), 'lighting');
assert.equal(normalizeTag('##lighting'), 'lighting');
assert.equal(normalizeTag('#'), '', 'a lone hash is not a tag');

// A comma separates tags in the input, so it can never survive inside one.
assert.equal(normalizeTag('a,b'), 'a b');

assert.equal(normalizeTag(''), '');
assert.equal(normalizeTag('   '), '');
assert.equal(normalizeTag(null), '');
assert.equal(normalizeTag(undefined), '');
assert.ok(normalizeTag('x'.repeat(200)).length <= TAG_MAX_LENGTH, 'a tag stays chip-sized');

// Control characters would render as boxes in a chip.
assert.equal(normalizeTag('one\ttwo'), 'one two');
assert.equal(normalizeTag('one\ntwo'), 'one two');

assert.equal(tagKey('Lighting'), 'lighting', 'identity ignores case');
assert.equal(tagKey('  #Lighting '), 'lighting', 'identity is taken after cleaning');

/* ================= lists ================= */

// The spelling that arrived first is the one the board keeps.
assert.deepEqual(normalizeTags(['Lighting', 'lighting', 'LIGHTING']), ['Lighting']);
assert.deepEqual(normalizeTags(['a', '', '  ', null, 'b']), ['a', 'b'], 'unusable entries drop out');
assert.deepEqual(normalizeTags('not an array'), [], 'a non-array is not a tag list');
assert.deepEqual(normalizeTags(null), []);

const tooMany = normalizeTags(Array.from({ length: 200 }, (_, i) => `tag${i}`));
assert.equal(tooMany.length, TAGS_MAX_PER_ITEM, 'one item cannot carry unbounded tags');

// "a, b, c" is three tags, which is how anyone would expect to type them.
assert.deepEqual(parseTagInput('mood, lighting, noir'), ['mood', 'lighting', 'noir']);
assert.deepEqual(parseTagInput('  mood ,, lighting  '), ['mood', 'lighting'], 'empty slots collapse');
assert.deepEqual(parseTagInput(''), []);

/* ================= add and remove ================= */

assert.deepEqual(addTags(['mood'], 'lighting'), ['mood', 'lighting'], 'a bare string is accepted');
assert.deepEqual(addTags(['mood'], ['a', 'b']), ['mood', 'a', 'b']);
assert.deepEqual(addTags(['Mood'], 'mood'), ['Mood'], 'adding a case-variant is not a second tag');
assert.deepEqual(addTags(null, 'a'), ['a'], 'an item with no tags yet can still be tagged');

assert.deepEqual(removeTag(['a', 'b'], 'a'), ['b']);
assert.deepEqual(removeTag(['Mood'], 'mood'), [], 'removal ignores case, like everything else');
assert.deepEqual(removeTag(['a'], ''), ['a'], 'removing nothing removes nothing');

assert.equal(hasTag(['Mood'], 'mood'), true);
assert.equal(hasTag(['Mood'], 'lighting'), false);
assert.equal(hasTag([], 'mood'), false);
assert.equal(hasTag(['mood'], ''), false);

/* ================= the board's tags ================= */

{
  const items = [
    { kind: 'image', tags: ['mood', 'noir'] },
    { kind: 'image', tags: ['mood', 'Lighting'] },
    { kind: 'image', tags: ['mood'] },
    { kind: 'note', tags: ['noir'] },
    { kind: 'arrow' },
  ];
  const isTaggable = it => it.kind === 'image' || it.kind === 'note';
  const board = collectBoardTags(items, isTaggable);

  // Most-used first is what makes the panel useful on a board of a hundred tags.
  assert.deepEqual(board, [
    { tag: 'mood', count: 3 },
    { tag: 'noir', count: 2 },
    { tag: 'Lighting', count: 1 },
  ]);

  // An untaggable kind contributes nothing even if something set a field on it.
  const withArrowTags = collectBoardTags(
    [...items, { kind: 'arrow', tags: ['ignored'] }],
    isTaggable,
  );
  assert.equal(withArrowTags.some(entry => entry.tag === 'ignored'), false);

  assert.deepEqual(collectBoardTags([], isTaggable), []);
}

/* ================= the filter ================= */

const lit = { tags: ['mood', 'lighting'] };
const bare = { tags: [] };

// An empty filter shows the board, rather than hiding all of it.
assert.equal(itemMatchesTags(lit, []), true);
assert.equal(itemMatchesTags(bare, []), true);
assert.equal(itemMatchesTags(bare, null), true);

assert.equal(itemMatchesTags(lit, ['mood']), true);
assert.equal(itemMatchesTags(lit, ['MOOD']), true, 'the filter ignores case too');
assert.equal(itemMatchesTags(bare, ['mood']), false, 'an untagged item is not a match');

// 'any' widens as tags are added, 'all' narrows — the two useful readings.
assert.equal(itemMatchesTags(lit, ['mood', 'noir'], 'any'), true);
assert.equal(itemMatchesTags(lit, ['mood', 'noir'], 'all'), false);
assert.equal(itemMatchesTags(lit, ['mood', 'lighting'], 'all'), true);
assert.equal(itemMatchesTags(lit, ['mood', 'noir']), true, "'any' is the default");

// A filter whose tags are all unusable is an empty filter, not an impossible one.
assert.equal(itemMatchesTags(bare, ['', '  ']), true);

/* ================= pruning ================= */

{
  const board = [{ tag: 'mood', count: 2 }, { tag: 'noir', count: 1 }];
  assert.deepEqual(pruneActiveTags(['mood', 'gone'], board), ['mood'],
    'deleting the last item carrying a tag must not strand the filter');
  assert.deepEqual(pruneActiveTags(['MOOD'], board), ['MOOD'], 'pruning ignores case');
  assert.deepEqual(pruneActiveTags(['gone'], board), [], 'a filter can prune to nothing');
  assert.deepEqual(pruneActiveTags(['mood'], []), [], 'an empty board keeps no filter');
  assert.deepEqual(pruneActiveTags(['mood'], ['mood', 'noir']), ['mood'],
    'a plain string list is accepted as well as counted entries');
}

/* ================= colours ================= */

assert.equal(normalizeTagColor('#5AA2FF'), '#5aa2ff', 'a colour is stored lowercase');
assert.equal(normalizeTagColor('5aa2ff'), '#5aa2ff', 'a missing hash is forgiven');
assert.equal(normalizeTagColor('#abc'), '#aabbcc', 'shorthand expands, for hand-edited files');
assert.equal(normalizeTagColor('rebeccapurple'), '', 'a name is not a colour we can paint with');
assert.equal(normalizeTagColor(''), '');
assert.equal(normalizeTagColor(null), '');
assert.equal(normalizeTagColor('#12345'), '', 'a malformed hex is refused rather than guessed at');

// Keys are tag identities, so a colour survives the tag being typed in another case.
assert.deepEqual(normalizeTagColors({ Mood: '#5AA2FF' }), { mood: '#5aa2ff' });
assert.deepEqual(normalizeTagColors({ mood: 'nonsense' }), {}, 'an unusable colour drops its entry');
assert.deepEqual(normalizeTagColors({ '  ': '#5aa2ff' }), {}, 'an unusable tag drops its entry');
assert.deepEqual(normalizeTagColors(null), {});
assert.deepEqual(normalizeTagColors(['#5aa2ff']), {}, 'an array is not a colour map');

// Two tags picked in a row should not land on the same colour.
assert.equal(suggestTagColor({}), TAG_COLOR_PALETTE[0]);
assert.equal(suggestTagColor({ a: TAG_COLOR_PALETTE[0] }), TAG_COLOR_PALETTE[1]);
assert.ok(
  TAG_COLOR_PALETTE.includes(suggestTagColor(Object.fromEntries(
    TAG_COLOR_PALETTE.map((color, i) => ['t' + i, color]),
  ))),
  'once every colour is taken it still returns a usable one',
);

/* The glow names one tag. Blending two would paint a third colour that stands
   for no tag at all, so the first tag carrying a colour wins. */
assert.equal(tagGlowColor(['noir', 'mood'], { mood: '#4cc86a' }), '#4cc86a');
assert.equal(tagGlowColor(['mood', 'noir'], { mood: '#4cc86a', noir: '#ff6b6b' }), '#4cc86a',
  'the order of the tags on the item decides, not the order of the colour map');
assert.equal(tagGlowColor(['Mood'], { mood: '#4cc86a' }), '#4cc86a', 'matching ignores case');
assert.equal(tagGlowColor(['warm'], { mood: '#4cc86a' }), '', 'an uncoloured tag glows with nothing');
assert.equal(tagGlowColor([], { mood: '#4cc86a' }), '');
assert.equal(tagGlowColor(['mood'], {}), '');

// A colour for a tag nothing carries any more would sit in the file forever.
assert.deepEqual(
  pruneTagColors({ mood: '#5aa2ff', gone: '#ff6b6b' }, [{ tag: 'mood', count: 2 }]),
  { mood: '#5aa2ff' },
);
assert.deepEqual(pruneTagColors({ mood: '#5aa2ff' }, []), {});

/* ================= the datalist trap ================= */

/* Rebuilding a <datalist> while its popover is open crashes the renderer
   outright — an access violation, not an exception, so nothing is logged and
   the window simply disappears. renderTagSelection runs after every tag edit,
   which is exactly when the popover is open, so the suggestion rebuild has to
   stay out of it and happen once per open instead. Found the hard way. */
{
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function renderTagSelection()');
  assert.notEqual(start, -1, 'renderTagSelection should exist');
  let depth = 0;
  let body = '';
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) { body = html.slice(start, i + 1); break; }
  }
  assert.ok(body, 'renderTagSelection should have a complete body');
  assert.ok(
    !body.includes('tagPopSuggestEl'),
    'renderTagSelection must not touch the suggestion datalist — rebuilding it while the '
    + 'popover is open crashes the renderer; refresh it when the panel opens instead',
  );
  assert.ok(
    /function setTagPanelOpen\([\s\S]{0,400}refreshTagSuggestions\(\)/.test(html),
    'opening the panel must refresh the suggestions, or autocomplete never populates',
  );
}

console.log('tags ok — values, board collection, filter modes, pruning and the datalist trap all hold');
