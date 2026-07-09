/**
 * Shared golden corpus for note markdown grammar tests.
 */

export const NOTE_TEST_CASES = [
  // empty / whitespace
  ['empty', ''],
  ['only newlines', '\n\n\n'],
  ['single newline', '\n'],
  ['spaces only line', '   '],
  ['leading trailing spaces', '  hello  '],
  ['blank middle', 'a\n\nb'],

  // plain
  ['plain', 'hello world'],
  ['multiline plain', 'one\ntwo\nthree'],
  ['unicode', 'café — 日本語'],
  ['emoji', '🔥 ship it ✨'],

  // lists
  ['bullet •', '• item'],
  ['bullet -', '- item'],
  ['bullet *', '* item'],
  ['numbered', '1. first'],
  ['numbered 12', '12. twelfth'],
  ['check unchecked', '[ ] todo'],
  ['check checked', '[x] done'],
  ['check X', '[X] done'],
  ['mixed lists', '• a\n1. b\n[ ] c\nplain'],

  // fake checkbox / list (must stay plain)
  ['fake check no space', '[x]nope'],
  ['fake check brackets only', '[x]'],
  ['fake check empty brackets', '[ ]'],
  ['literal brackets', 'see [notes] here'],
  ['parens only', 'call (later)'],
  ['almost markdown', '[label](not closed'],
  ['almost markdown 2', '[label]()'],

  // markdown links
  ['md link', '[docs](https://example.com)'],
  ['md link empty label', '[](https://example.com)'],
  ['md link with spaces in label', '[my docs](https://example.com/path)'],
  ['md redundant url label', '[https://x.com](https://x.com)'],
  ['md http', '[site](http://example.com)'],
  ['text + md link', 'see [docs](https://example.com) please'],
  ['two md links', '[a](https://a.com) and [b](https://b.com)'],

  // bare URLs
  ['bare https', 'https://x.com'],
  ['bare http', 'http://x.com'],
  ['bare in sentence', 'go https://x.com now'],
  ['bare adjacent punct', 'see https://x.com.'],
  ['bare then comma', 'https://x.com, ok'],

  // combined
  ['list + link', '• read [guide](https://ex.com)'],
  ['check + bare', '[ ] https://todo.example/item'],
  ['number + md', '1. open [app](https://app.test)'],
  ['all constructs', 'plain\n• bullet\n2. num\n[x] check\n[lab](https://a.com)\nhttps://b.com\n'],

  // characters that must not become links
  ['brackets parens literal', 'array[0] = (x)'],
  ['markdown-looking junk', '[[nested]] ((parens))'],

  // link edge cases the grammar allows
  ['label with parens', '[see (this)](https://example.com)'],
  ['url with path query', '[q](https://ex.com/a?b=1&c=2)'],
  ['url with hash', '[h](https://ex.com#frag)'],
];
