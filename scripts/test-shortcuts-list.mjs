/**
 * SHORTCUTS (index.html) against the key handlers, both ways:
 *  - every key a handler acts on is listed, in the group for that place
 *    (board, Home, Compare, Remove object, main.js, the note editor);
 *  - every listed key has a handler there.
 * The handlers are read as text. A line's modifiers come from the line and
 * from the blocks it sits in (by indentation): `mod &&` or `if (mod) {` is
 * Ctrl, `e.shiftKey &&` is Shift, `if (e.altKey) {` is Alt, and a bare
 * `e.shiftKey` (a ternary or a value) means both with and without Shift.
 * Also checks the ? panel is drawn from the list, not written by hand.
 *
 * Usage: node scripts/test-shortcuts-list.mjs [index.html] [main.js]
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Checkouts here are CRLF (core.autocrlf); every anchor below is written with \n.
const read = file => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const html = read(process.argv[2] || path.join(root, 'index.html'));
const mainJs = read(process.argv[3] || path.join(root, 'main.js'));

function slice(text, start, end, what) {
  const a = text.indexOf(start);
  assert.ok(a >= 0, `${what}: start anchor not found`);
  const b = text.indexOf(end, a + start.length);
  assert.ok(b >= 0, `${what}: end anchor not found`);
  return text.slice(a, b + end.length);
}
function between(text, start, end, what) {
  const a = text.indexOf(start);
  assert.ok(a >= 0, `${what}: start anchor not found`);
  const b = text.indexOf(end, a + start.length);
  assert.ok(b >= 0, `${what}: end anchor not found`);
  return text.slice(a, b);
}

/* ---- the list ---- */
const listSrc = slice(html, 'const SHORTCUTS = [', '\n];', 'SHORTCUTS');
const SHORTCUTS = vm.runInNewContext('(' + listSrc.slice('const SHORTCUTS = '.length, -1) + ')');
const CONTEXTS = vm.runInNewContext('(' + slice(html, 'const SHORTCUT_CONTEXTS = {', '};', 'SHORTCUT_CONTEXTS').slice('const SHORTCUT_CONTEXTS = '.length, -1) + ')');
assert.ok(SHORTCUTS.length >= 60, `the list has ${SHORTCUTS.length} entries`);
const cats = new Set(SHORTCUTS.map(s => s.cat));
for (const c of Object.keys(CONTEXTS)) assert.ok(cats.has(c), `context for unknown group ${c}`);

const MODS = ['ctrl', 'alt', 'shift'];
const KEY_NAMES = new Set(['del', 'backspace', 'esc', 'enter', 'space', 'arrows', 'f2', 'alt', 'ctrl', 'shift']);
const token = (mods, key) => [...MODS.filter(m => mods.has(m) && m !== key), key].join('+');

function comboTokens(combo, label) {
  const keys = combo.filter(k => !k.startsWith('~')).map(k => k.toLowerCase());
  assert.ok(combo.length, `${label}: an empty combination`);
  if (!keys.length) return null; // a mouse action only
  const key = keys.at(-1);
  const mods = new Set(keys.slice(0, -1));
  for (const m of mods) assert.ok(MODS.includes(m), `${label}: ${m} is not a modifier`);
  assert.ok(key.length === 1 || KEY_NAMES.has(key), `${label}: unknown key ${key}`);
  return { token: token(mods, key), mouse: combo.some(k => k.startsWith('~')) };
}

/* Where each entry is handled. */
const REGION_OF_CAT = { Compare: 'compare', 'Remove object': 'fill', Home: 'home', Window: 'main' };
const REGION_OF_LABEL = { Paste: 'paste', 'Finish editing': 'noteEditor' };
const listed = new Map(); // region -> Map(token -> [labels]), mouse-only parts included
const required = new Map(); // region -> Set(tokens) that must have a handler
for (const s of SHORTCUTS) {
  assert.ok(s.cat && s.label && Array.isArray(s.keys), `entry ${JSON.stringify(s)}`);
  const region = REGION_OF_LABEL[s.label] || REGION_OF_CAT[s.cat] || 'board';
  for (const combo of [s.keys, ...(s.alt || [])]) {
    const t = comboTokens(combo, s.label);
    if (!t) continue;
    if (!listed.has(region)) listed.set(region, new Map());
    const labels = listed.get(region).get(t.token) || [];
    listed.get(region).set(t.token, [...labels, s.label]);
    if (!t.mouse) {
      if (!required.has(region)) required.set(region, new Set());
      required.get(region).add(t.token);
    }
  }
}
// One key, one meaning, wherever you are.
for (const [region, tokens] of listed) {
  for (const [t, labels] of tokens) {
    const keyOnly = labels.filter(l => SHORTCUTS.some(s => s.label === l && !s.keys.some(k => k.startsWith('~'))));
    assert.ok(keyOnly.length <= 1, `${t} is listed twice in ${region}: ${keyOnly.join(', ')}`);
  }
}

/* ---- the handlers ---- */
const KEY_ALIAS = { escape: 'esc', delete: 'del', ' ': 'space', arrowleft: 'arrows', arrowright: 'arrows', arrowup: 'arrows', arrowdown: 'arrows', altleft: 'alt', altright: 'alt' };
const norm = k => KEY_ALIAS[k.toLowerCase()] || k.toLowerCase();

function handledTokens(src) {
  const out = new Set();
  const stack = []; // { indent, mods }
  for (const line of src.split('\n')) {
    if (!line.trim() || line.trim().startsWith('//')) continue;
    const indent = line.match(/^ */)[0].length;
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const own = new Set();
    if (/(?<!!)\bmod &&|if \(mod\)/.test(line)) own.add('ctrl');
    if (/e\.shiftKey &&/.test(line)) own.add('shift');
    if (/if \(e\.altKey\) \{/.test(line)) own.add('alt');
    const mods = new Set([...stack.flatMap(b => [...b.mods]), ...own]);
    const keys = [
      ...[...line.matchAll(/\bk === '([^']+)'/g)].map(m => m[1]),
      ...[...line.matchAll(/\be\.key === '([^']+)'/g)].map(m => m[1]),
      ...[...line.matchAll(/\be\.code === '([^']+)'/g)].map(m => m[1]),
      ...(/\bk\.startsWith\('arrow'\)/.test(line) ? ['arrows'] : []),
    ].map(norm);
    // A bare e.shiftKey (a value or a ternary) acts with and without Shift.
    const both = /e\.shiftKey(?! &&)/.test(line) && !/!e\.shiftKey/.test(line) && !own.has('shift');
    for (const key of keys) {
      out.add(token(mods, key));
      if (both) out.add(token(new Set([...mods, 'shift']), key));
    }
    if (line.trimEnd().endsWith('{')) stack.push({ indent, mods: own });
  }
  return out;
}

const board = slice(html, "/* ================= keyboard ================= */\nwindow.addEventListener('keydown', e => {", '\n});\n', 'board key handler');
const noteEditPrefixEnd = "  if (formControl || e.target.closest('#noteEditor')) return;\n";
const dialogs = "  if (helpModal.classList.contains('show')";
const regions = {
  // Ctrl+Z / Ctrl+Y while a note is open run the note's own history: Undo and Redo again.
  dialogs: between(board, dialogs, '\n  if (onLanding) {', 'dialog keys'),
  home: between(board, '\n  if (onLanding) {', '\n  if (fillSession) {', 'Home keys'),
  fill: between(board, '\n  if (fillSession) {', "\n  if (k === 'escape') {", 'Remove object keys'),
  board: board.slice(board.indexOf("\n  if (k === 'escape') {")),
  compare: slice(html, "window.addEventListener('keydown', e => {\n  const s = compareSession;", '\n}, true);', 'Compare key handler'),
  noteEditor: slice(html, "noteEd.addEventListener('keydown', e => {", '\n});', 'note editor key handler'),
};
assert.ok(board.indexOf(noteEditPrefixEnd) > 0 && board.indexOf(noteEditPrefixEnd) < board.indexOf(dialogs), 'the note-editing prefix comes first');

const handled = {};
for (const [name, src] of Object.entries(regions)) handled[name] = handledTokens(src);
// main.js catches two combinations before the page sees them.
const before = slice(mainJs, "wc.on('before-input-event', (e, input) => {", '\n  });', 'main.js before-input-event');
handled.main = new Set([...before.matchAll(/if \(input\.control && (!?)input\.alt && (!?)input\.shift && key === '(\w)'\)/g)]
  .map(m => token(new Set(['ctrl', ...(m[1] ? [] : ['alt']), ...(m[2] ? [] : ['shift'])]), m[3])));
assert.ok(handled.main.size >= 2, 'main.js shortcuts were read');
// Paste is the clipboard's paste event, not a key handler.
handled.paste = /window\.addEventListener\('paste', async e => \{\n  if \(onLanding\) return;/.test(html) ? new Set(['ctrl+v']) : new Set();

// Keys a handler takes that are not shortcuts, with the reason.
const NOT_SHORTCUTS = {
  // Compare lets Tab and Enter reach its focused bar buttons.
  compare: new Set(['tab', 'enter']),
};

/* ---- both ways ---- */
const report = {};
for (const region of ['board', 'home', 'fill', 'compare', 'main']) {
  const list = listed.get(region) || new Map();
  const unlisted = [...handled[region]].filter(t => !list.has(t) && !NOT_SHORTCUTS[region]?.has(t));
  assert.deepEqual(unlisted, [], `handled in ${region} but not in SHORTCUTS: ${unlisted.join(', ')}`);
  report[region] = handled[region].size;
}
for (const [region, tokens] of required) {
  const missing = [...tokens].filter(t => !handled[region]?.has(t));
  assert.deepEqual(missing, [], `listed for ${region} but no handler takes it: ${missing.join(', ')}`);
}
assert.ok(handled.noteEditor.has('esc') && handled.dialogs.has('esc'), 'Esc finishes a note and closes dialogs');

/* ---- the ? panel and Settings draw from the list ---- */
const help = slice(html, '<div id="helpModal" class="modal">', '<div id="settingsModal" class="modal">', '? panel markup');
assert.equal((help.match(/class="ks"/g) || []).length, 1, 'the ? panel writes only the Snip row by hand');
assert.match(html, /function renderHelpShortcuts\(\) \{[\s\S]*?for \(const s of SHORTCUTS\.filter/, 'the ? panel renders SHORTCUTS');
assert.match(html, /\n  renderShortcutsList\(\);\n  renderHelpShortcuts\(\);\n/, 'both lists are drawn at startup');
assert.match(html, /function renderShortcutsList\(\)\{[\s\S]*?SHORTCUTS\.filter\(s => s\.cat === cat\)/, 'Settings renders SHORTCUTS');

console.log(`shortcuts list ok — ${SHORTCUTS.length} entries; handled keys checked: ${JSON.stringify(report)}`);
