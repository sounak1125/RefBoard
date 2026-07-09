/**
 * Golden round-trip: serialize(hydrate(x)) === x
 * Run: node scripts/test-note-roundtrip.mjs
 */

import { hydrateNoteDom, serializeNoteDom, parseNoteLine, parseNoteLinkSegments } from './note-dom.mjs';
import { NOTE_TEST_CASES } from './note-test-corpus.mjs';

let failed = 0;
const failures = [];

for (const [name, input] of NOTE_TEST_CASES) {
  const dom = hydrateNoteDom(input);
  const out = serializeNoteDom(dom);
  if (out !== input) {
    failed++;
    failures.push({ name, input, out });
  }
}

// Extra: dirty DOM (contenteditable junk) should strip, not crash
{
  const frag = hydrateNoteDom('hello');
  const line = frag.childNodes[0];
  const span = line.ownerDocument.createElement('span');
  span.setAttribute('style', 'color:red');
  span.appendChild(line.ownerDocument.createTextNode(' world'));
  line.appendChild(span);
  const br = line.ownerDocument.createElement('br');
  line.appendChild(br);
  const nbsp = line.ownerDocument.createTextNode('\u00a0!');
  line.appendChild(nbsp);
  const cleaned = serializeNoteDom(frag);
  if (cleaned !== 'hello world !') {
    failed++;
    failures.push({ name: 'strip junk', input: '(dirty DOM)', out: cleaned, expected: 'hello world !' });
  }
}

// Parser sanity: fake checkbox is plain
{
  const p = parseNoteLine('[x]nope');
  if (p.type !== 'plain') {
    failed++;
    failures.push({ name: 'parse fake check', input: '[x]nope', out: JSON.stringify(p) });
  }
}

// Parser: bare vs md segments
{
  const bare = parseNoteLinkSegments('https://x.com');
  const md = parseNoteLinkSegments('[https://x.com](https://x.com)');
  if (!(bare.length === 1 && bare[0].bare === true)) {
    failed++;
    failures.push({ name: 'bare flag', out: JSON.stringify(bare) });
  }
  if (!(md.length === 1 && md[0].bare === false)) {
    failed++;
    failures.push({ name: 'md flag', out: JSON.stringify(md) });
  }
}

console.log(`note-dom round-trip: ${NOTE_TEST_CASES.length} golden cases + extras`);
if (failed === 0) {
  console.log('ALL PASSED');
  process.exit(0);
}

console.log(`FAILED: ${failed}`);
for (const f of failures) {
  console.log('---');
  console.log('name:', f.name);
  console.log('input:   ', JSON.stringify(f.input));
  console.log('output:  ', JSON.stringify(f.out));
  if (f.expected) console.log('expected:', JSON.stringify(f.expected));
}
process.exit(1);
