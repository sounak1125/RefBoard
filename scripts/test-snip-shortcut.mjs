/**
 * The Snip shortcut setting: recording, validation, display and the AltGr
 * warning (scripts/snip-shortcut.js, shared by main.js and the page), plus how
 * main.js and the page are wired to it.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const S = require('./snip-shortcut.js');

const press = (code, mods = '') => S.acceleratorFromEvent({
  code, ctrlKey: mods.includes('c'), altKey: mods.includes('a'), shiftKey: mods.includes('s'), metaKey: mods.includes('w'),
});

assert.equal(S.DEFAULT_ACCELERATOR, 'Control+Alt+S');

/* ---------- keys, by physical code ---------- */
assert.equal(S.keyFromCode('KeyS'), 'S');
assert.equal(S.keyFromCode('Digit0'), '0');
assert.equal(S.keyFromCode('F1'), 'F1');
assert.equal(S.keyFromCode('F24'), 'F24');
for (const bad of ['F0', 'F25', 'Space', 'Enter', 'Numpad1', 'Semicolon', 'BracketLeft', 'ArrowUp', 'Tab', '', null]) {
  assert.equal(S.keyFromCode(bad), null, `${bad} is not an allowed key`);
}

/* ---------- recording ---------- */
assert.deepEqual(press('KeyK', 'ca'), { accelerator: 'Control+Alt+K' });
assert.deepEqual(press('KeyK', 'cas'), { accelerator: 'Control+Alt+Shift+K' });
assert.deepEqual(press('KeyS', 'cs'), { accelerator: 'Control+Shift+S' });
assert.deepEqual(press('KeyK', 'as'), { accelerator: 'Alt+Shift+K' });
assert.deepEqual(press('Digit7', 'ca'), { accelerator: 'Control+Alt+7' });
// One modifier is what apps use (Ctrl+C, Ctrl+S, Alt+F, Alt+F4, Ctrl+F5,
// Shift+F10...); a global shortcut would take it from every app on the PC.
for (const [code, mods] of [['KeyC', 'c'], ['KeyV', 'c'], ['KeyZ', 'c'], ['KeyS', 'c'], ['KeyF', 'a'], ['F4', 'a'], ['F5', 'c'], ['F10', 's'], ['KeyS', 's'], ['Digit1', 'a'], ['F12', 'c']]) {
  assert.deepEqual(press(code, mods), { reason: 'needs-two-modifiers' }, `${mods}+${code} is refused`);
}
assert.deepEqual(press('F9'), { reason: 'needs-two-modifiers' }, 'a bare F-key is refused');
assert.deepEqual(press('KeyS'), { reason: 'needs-two-modifiers' }, 'a bare letter is refused');
// F13-F24 are on no keyboard by default: any modifiers, or none.
assert.deepEqual(press('F13'), { accelerator: 'F13' });
assert.deepEqual(press('F20', 's'), { accelerator: 'Shift+F20' });
assert.deepEqual(press('F24', 'cas'), { accelerator: 'Control+Alt+Shift+F24' });
for (const mod of ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft']) {
  assert.deepEqual(press(mod, 'cas'), { ignore: true }, `${mod} alone is still being held`);
}
assert.deepEqual(press('KeyS', 'cw'), { reason: 'win' }, 'no Win key');
assert.deepEqual(press('Space', 'c'), { reason: 'unsupported-key' });
assert.deepEqual(press('Escape', 'c'), { reason: 'unsupported-key' });
// The code, not the character: AZERTY's A key is code KeyQ and records as Q.
assert.deepEqual(S.acceleratorFromEvent({ code: 'KeyQ', key: 'a', ctrlKey: true, altKey: true }), { accelerator: 'Control+Alt+Q' });
assert.equal(S.hintFor('needs-two-modifiers'), 'Use two of Ctrl, Alt and Shift');
assert.equal(S.hintFor('nope'), '');

/* ---------- validation (what main.js accepts from the page) ---------- */
for (const [input, canonical] of [
  ['Control+Alt+S', 'Control+Alt+S'],
  ['Alt+Control+s', 'Control+Alt+S'],
  ['ctrl+shift+f12', 'Control+Shift+F12'],
  ['Shift+Alt+Ctrl+9', 'Control+Alt+Shift+9'],
  ['control+shift+s', 'Control+Shift+S'],
  ['Shift+Alt+K', 'Alt+Shift+K'],
  [' Control + Alt + K ', 'Control+Alt+K'],
  ['F13', 'F13'],
  ['shift+f20', 'Shift+F20'],
  ['Control+F24', 'Control+F24'],
]) {
  assert.equal(S.normalizeAccelerator(input), canonical, `${input} -> ${canonical}`);
}
for (const bad of [
  'Control+C', 'Control+V', 'Control+Z', 'Control+S', 'Alt+F', 'Alt+F4', 'Control+F5', 'Shift+F10', 'Shift+F1', 'Control+K',
  'S', 'F5', 'F12', 'Shift+S', 'Control', 'F13+Control', 'Control+Alt', 'Control+Control+S', 'Control+S+K', 'Control+Space',
  'Super+S', 'Meta+S', 'Command+S', 'CommandOrControl+S', 'Control+Alt+F25', 'Control++S', 'Control+S+',
  'S+Control', '', null, 42, { accelerator: 'Control+S' }, 'Control+' + 'A'.repeat(50),
]) {
  assert.equal(S.normalizeAccelerator(bad), null, `${JSON.stringify(bad)} is refused`);
}

/* ---------- round trip and display ---------- */
for (const code of ['KeyA', 'KeyZ', 'Digit0', 'Digit9', 'F1', 'F12', 'F13', 'F24']) {
  for (const mods of ['ca', 'cs', 'as', 'cas', ...(/^F(1[3-9]|2)/.test(code) ? ['', 'c', 'a', 's'] : [])]) {
    const { accelerator } = press(code, mods);
    assert.ok(accelerator, `${mods}+${code} records`);
    assert.equal(S.normalizeAccelerator(accelerator), accelerator, `${accelerator} is already canonical`);
    assert.deepEqual(S.parseAccelerator(accelerator), {
      ctrl: mods.includes('c'), alt: mods.includes('a'), shift: mods.includes('s'), key: S.keyFromCode(code),
    });
  }
}
assert.deepEqual(S.acceleratorCaps('Control+Alt+S'), ['Ctrl', 'Alt', 'S']);
assert.deepEqual(S.acceleratorCaps('Shift+Alt+Control+F4'), ['Ctrl', 'Alt', 'Shift', 'F4']);
assert.deepEqual(S.acceleratorCaps('nonsense'), []);
assert.equal(S.acceleratorLabel('Control+Alt+S'), 'Ctrl+Alt+S');
assert.equal(S.acceleratorLabel('Alt+Shift+F2'), 'Alt+Shift+F2');
assert.equal(S.acceleratorLabel('F13'), 'F13');

/* ---------- the AltGr warning ---------- */
assert.equal(S.blocksAltGr('Control+Alt+S'), true, 'the default warns too: that is the whole point');
assert.equal(S.blocksAltGr('Control+Alt+Shift+K'), true);
assert.equal(S.blocksAltGr('Control+Shift+K'), false);
assert.equal(S.blocksAltGr('Alt+Shift+K'), false);
assert.equal(S.blocksAltGr('Shift+F20'), false);
assert.equal(S.blocksAltGr('Control+K'), false, 'not a valid combo at all');
assert.equal(S.blocksAltGr('junk'), false);

/* ---------- stored setting ---------- */
assert.deepEqual(S.normalizeSnipShortcut(null), { enabled: true, accelerator: 'Control+Alt+S' }, 'missing file: defaults');
assert.deepEqual(S.normalizeSnipShortcut('garbage'), { enabled: true, accelerator: 'Control+Alt+S' });
assert.deepEqual(S.normalizeSnipShortcut({ enabled: false, accelerator: 'alt+control+k' }), { enabled: false, accelerator: 'Control+Alt+K' });
assert.deepEqual(S.normalizeSnipShortcut({ enabled: 'yes', accelerator: 'Super+K' }), { enabled: true, accelerator: 'Control+Alt+S' });
// A value saved under the old, looser rule loads as the default.
assert.deepEqual(S.normalizeSnipShortcut({ enabled: true, accelerator: 'Control+S' }), { enabled: true, accelerator: 'Control+Alt+S' });
assert.deepEqual(S.normalizeSnipShortcut({ enabled: false, accelerator: 'Shift+F9' }), { enabled: false, accelerator: 'Control+Alt+S' });

/* ---------- wiring ---------- */
const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert.match(main, /require\('\.\/scripts\/snip-shortcut'\)/, 'main validates with the shared module');
assert.match(main, /normalizeAccelerator\(request\.accelerator\)/, 'main never trusts the page\'s accelerator');
assert.match(main, /writeJsonAtomic\(snipShortcutPath\(\)/, 'the setting is written atomically');
assert.match(main, /snip-shortcut\.json/);
assert.match(main, /app\.on\('will-quit', \(\) => \{\s*flushSnipShortcutSave\(\);/, 'a save still in flight is written on quit');
assert.match(main, /writeJsonAtomicSync\(snipShortcutPath\(\), pending\.value\)/, 'synchronously, with the same atomic write');
for (const ending of ["sender.once('destroyed', end)", "sender.once('render-process-gone', end)", "sender.once('did-start-loading', end)", 'setTimeout(end, snipRecordingTimeoutMs)']) {
  assert.ok(main.includes(ending), `a recording also ends through ${ending}`);
}
assert.match(main, /let snipRecordingTimeoutMs = 30000;/, 'the backstop is 30 s');
assert.match(html, /function closeSettings\(\) \{[\s\S]{0,80}stopSnipRecording\(\);/, 'closing Settings ends a recording');
assert.match(main, /if \(snipRecorder === wc\) return;/, 'main\'s own Ctrl+T stays out of a recording');
assert.match(main, /Change it in Settings → Shortcuts\./, 'the startup toast says where to fix it');
assert.doesNotMatch(main, /'Ctrl\+Alt\+S is in use/, 'the toast names the live combination');
assert.match(html, /<script src="\.\/scripts\/snip-shortcut\.js"><\/script>/);
assert.match(html, /window\.addEventListener\('keydown', onSnipRecordKey, true\)/, 'recording runs ahead of the board\'s key handlers');
assert.match(html, /e\.stopImmediatePropagation\(\);/);
assert.match(html, /block\.id = 's2SnipBlock';/, 'the snip block is rebuilt with the Shortcuts list');
assert.match(html, /function restoreSettingsDefaults\(\) \{[\s\S]*?updateSnipShortcut\(\{ enabled: true, accelerator:/, 'Restore defaults restores the snip shortcut');
assert.match(html, /id="helpSnipKeys"/, 'the ? panel shows the live combination');

console.log('snip shortcut ok — recording, validation, round trip, caps, AltGr warning, stored setting');
