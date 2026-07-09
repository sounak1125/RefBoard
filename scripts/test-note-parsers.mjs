/**
 * Assert index.html parsers match note-dom.mjs on a shared corpus.
 * Extraction keys off /* NOTE_PARSERS_BEGIN *\/ … /* NOTE_PARSERS_END *\/.
 * Run: node scripts/test-note-parsers.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNoteLine as modParseLine, parseNoteLinkSegments as modParseSegs } from './note-dom.mjs';
import { NOTE_TEST_CASES } from './note-test-corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = path.join(__dirname, '..', 'index.html');
const BEGIN = '/* NOTE_PARSERS_BEGIN */';
const END = '/* NOTE_PARSERS_END */';

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

function extractIndexParsers(html) {
  const start = html.indexOf(BEGIN);
  const end = html.indexOf(END);
  if (start < 0 || end < 0) {
    fail(
      `Missing ${BEGIN} / ${END} markers in index.html. ` +
      'Parser sync test cannot run — add the markers around parseNoteLine and parseNoteLinkSegments.'
    );
  }
  if (end <= start) {
    fail(`NOTE_PARSERS markers are out of order in index.html (END before BEGIN).`);
  }
  const region = html.slice(start + BEGIN.length, end).trim();
  if (!region) {
    fail('NOTE_PARSERS region in index.html is empty.');
  }
  if (!/function\s+parseNoteLine\s*\(/.test(region) || !/function\s+parseNoteLinkSegments\s*\(/.test(region)) {
    fail(
      'NOTE_PARSERS region must define both parseNoteLine and parseNoteLinkSegments. ' +
      'Got region length ' + region.length + '.'
    );
  }
  let parseNoteLine;
  let parseNoteLinkSegments;
  try {
    // Pure functions only — no DOM / globals required.
    ({ parseNoteLine, parseNoteLinkSegments } = new Function(
      `${region}\nreturn { parseNoteLine, parseNoteLinkSegments };`
    )());
  } catch (e) {
    fail(`Failed to eval NOTE_PARSERS region: ${e.message}`);
  }
  if (typeof parseNoteLine !== 'function' || typeof parseNoteLinkSegments !== 'function') {
    fail('Eval of NOTE_PARSERS region did not return both parser functions.');
  }
  return { parseNoteLine, parseNoteLinkSegments };
}

function normalizeLine(p) {
  const out = { type: p.type, body: p.body };
  if (p.type === 'check') out.checked = !!p.checked;
  if (p.type === 'number') out.n = p.n;
  return out;
}

/** Compare only fields index.html produces (ignore note-dom `bare`). */
function normalizeSegs(segs) {
  return segs.map(s => {
    if (s.type === 'link') return { type: 'link', text: s.text, url: s.url };
    return { type: 'text', text: s.text };
  });
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const html = fs.readFileSync(INDEX_HTML, 'utf8');
const htmlParsers = extractIndexParsers(html);

let failed = 0;
const failures = [];

function check(name, kind, input, a, b) {
  if (!same(a, b)) {
    failed++;
    failures.push({ name, kind, input, index: a, noteDom: b });
  }
}

for (const [name, input] of NOTE_TEST_CASES) {
  const lines = String(input).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const a = normalizeLine(htmlParsers.parseNoteLine(line));
    const b = normalizeLine(modParseLine(line));
    check(`${name} [line ${i}]`, 'parseNoteLine', line, a, b);
  }

  // Full string + each line body through link segmenter
  check(name, 'parseNoteLinkSegments', input,
    normalizeSegs(htmlParsers.parseNoteLinkSegments(input)),
    normalizeSegs(modParseSegs(input)));

  for (let i = 0; i < lines.length; i++) {
    const body = modParseLine(lines[i]).body;
    check(`${name} [body ${i}]`, 'parseNoteLinkSegments', body,
      normalizeSegs(htmlParsers.parseNoteLinkSegments(body)),
      normalizeSegs(modParseSegs(body)));
  }
}

console.log(`note-parsers sync: ${NOTE_TEST_CASES.length} corpus cases (index.html vs note-dom.mjs)`);
if (failed === 0) {
  console.log('ALL PASSED');
  process.exit(0);
}

console.log(`FAILED: ${failed}`);
for (const f of failures.slice(0, 20)) {
  console.log('---');
  console.log('name:', f.name, '|', f.kind);
  console.log('input:  ', JSON.stringify(f.input));
  console.log('index:  ', JSON.stringify(f.index));
  console.log('noteDom:', JSON.stringify(f.noteDom));
}
if (failures.length > 20) console.log(`… and ${failures.length - 20} more`);
process.exit(1);
