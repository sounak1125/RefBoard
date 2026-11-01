import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const mainJs = await readFile(new URL('../main.js', import.meta.url), 'utf8');
// Board export (Viewer / PDF) registers its handlers from its own module,
// handed ipcMain by main.js; its channels count as main's.
const boardExportMain = await readFile(new URL('./board-export-main.js', import.meta.url), 'utf8');
const main = `${mainJs}
${boardExportMain}`;
const preload = await readFile(new URL('../preload.js', import.meta.url), 'utf8');

const channels = src => pattern => {
  const found = new Set();
  for (const m of src.matchAll(pattern)) found.add(m[1]);
  return found;
};
const inPreload = channels(preload);
const inMain = channels(main);

const invoked = inPreload(/ipcRenderer\.invoke\('([^']+)'/g);
const sent = inPreload(/ipcRenderer\.send\('([^']+)'/g);
const listened = inPreload(/ipcRenderer\.on\('([^']+)'/g);

const handled = inMain(/ipcMain\.handle\('([^']+)'/g);
const received = inMain(/ipcMain\.on\('([^']+)'/g);
const emitted = (() => {
  const found = new Set();
  for (const pattern of [
    /(?:webContents|sender)\.send\('([^']+)'/g,
    /sendTo(?:Panes|Primary)\([^,]+,\s*'([^']+)'/g,
    /(?:primary|secondary|wc)\.send\('([^']+)'/g,
    /(?:primaryWc|secondaryWc)\.send\('([^']+)'/g,
  ]) {
    for (const m of main.matchAll(pattern)) found.add(m[1]);
  }
  return found;
})();

assert.ok(invoked.size > 40, `expected the full invoke bridge, saw ${invoked.size} channels`);

// Every channel the bridge invokes must have a main-process handler. Without this,
// removing a handler leaves a bridge method that exists but always rejects, and the
// renderer's "is this the desktop app?" checks silently take the wrong branch.
const missingHandlers = [...invoked].filter(c => !handled.has(c)).sort();
assert.deepEqual(missingHandlers, [], `preload invokes channels with no ipcMain.handle in main.js: ${missingHandlers.join(', ')}`);

const missingReceivers = [...sent].filter(c => !received.has(c)).sort();
assert.deepEqual(missingReceivers, [], `preload sends channels with no ipcMain.on in main.js: ${missingReceivers.join(', ')}`);

const missingSenders = [...listened].filter(c => !emitted.has(c)).sort();
assert.deepEqual(missingSenders, [], `preload listens on channels main.js never sends: ${missingSenders.join(', ')}`);

// The export flow specifically: these three were dropped in the animatics removal
// (ff90c34) and shipped broken, so pin them by name.
for (const channel of ['choose-folder', 'get-default-export-dir', 'write-export-files']) {
  assert.ok(handled.has(channel), `main.js must handle '${channel}' for image export to work`);
  assert.ok(invoked.has(channel), `preload must expose '${channel}' to the renderer`);
}

// Snip to board: main.js delivers the crop to a board pane on 'snip-image'.
assert.ok(listened.has('snip-image'), 'preload must listen for snip-image');
assert.ok(emitted.has('snip-image'), 'main.js must send snip-image to the destination pane');
// Its shortcut setting, owned by main.js and changed from Settings → Shortcuts.
for (const channel of ['snip-shortcut-get', 'snip-shortcut-set']) {
  assert.ok(invoked.has(channel) && handled.has(channel), `'${channel}' must be bridged and handled`);
}
assert.ok(sent.has('snip-shortcut-recording') && received.has('snip-shortcut-recording'), "'snip-shortcut-recording' must be bridged and received");
assert.ok(listened.has('snip-shortcut-changed') && emitted.has('snip-shortcut-changed'), "'snip-shortcut-changed' must reach every pane");
assert.match(main, /for \(const win of windows\) sendToPanes\(win, 'snip-shortcut-changed'/, 'a change is broadcast to every pane of every window');

// The snip overlays have their own preload with only the overlay channels:
// a page that shows a frozen screen has no business reaching RefBoardAPI.
const snipPreload = await readFile(new URL('./snip-preload.js', import.meta.url), 'utf8');
const inSnip = channels(snipPreload);
const snipChannels = [
  ...inSnip(/ipcRenderer\.(?:invoke|send|on)\('([^']+)'/g),
].sort();
assert.deepEqual(snipChannels, ['snip-overlay-cancel', 'snip-overlay-finish', 'snip-overlay-init', 'snip-overlay-ready']);
assert.deepEqual([...inSnip(/exposeInMainWorld\('([^']+)'/g)], ['SnipAPI'], 'the snip overlay preload must expose SnipAPI alone, not RefBoardAPI');
for (const channel of inSnip(/ipcRenderer\.invoke\('([^']+)'/g)) {
  assert.ok(handled.has(channel), `main.js must handle snip channel '${channel}'`);
}
for (const channel of inSnip(/ipcRenderer\.send\('([^']+)'/g)) {
  assert.ok(received.has(channel), `main.js must receive snip channel '${channel}'`);
}
for (const channel of snipChannels) {
  assert.ok(!invoked.has(channel) && !sent.has(channel), `board preload must not reach overlay channel '${channel}'`);
}
// The overlay window is locked down like a board window, sandboxed besides.
const overlayWindow = main.slice(main.indexOf('function createSnipOverlay'), main.indexOf('function watchSnipOverlayBlur'));
for (const setting of [/contextIsolation:\s*true/, /sandbox:\s*true/, /nodeIntegration:\s*false/, /snip-preload\.js/]) {
  assert.match(overlayWindow, setting, `the snip overlay window must set ${setting}`);
}
assert.match(overlayWindow, /will-navigate/, 'the snip overlay must refuse navigation');
assert.match(overlayWindow, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/, 'the snip overlay must refuse new windows');

// Board export as a Viewer or PDF: the four channels, registered by main.js,
// and the hidden PDF window locked down (sandboxed, no preload, its own
// in-memory partition, nothing but its own file and data:/blob: URLs).
assert.match(mainJs, /registerBoardExportIpc\(\{[\s\S]*?ipcMain[\s\S]*?\}\)/, 'main.js must register the board export handlers');
for (const channel of ['board-export-begin', 'board-export-images', 'board-export-finish', 'board-export-abort']) {
  assert.ok(invoked.has(channel) && handled.has(channel), `'${channel}' must be bridged and handled`);
}
const pdfWindow = boardExportMain.slice(boardExportMain.indexOf('async function renderPdf'), boardExportMain.indexOf('function registerBoardExportIpc'));
for (const setting of [/sandbox:\s*true/, /contextIsolation:\s*true/, /nodeIntegration:\s*false/, /show:\s*false/, /partition,/, /onBeforeRequest/, /cancel:\s*true/, /will-navigate/, /setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/, /win\.destroy\(\)/]) {
  assert.match(pdfWindow, setting, `the hidden PDF window must use ${setting}`);
}
assert.doesNotMatch(pdfWindow, /preload/, 'the hidden PDF window must not load a preload');
assert.doesNotMatch(pdfWindow, /persist:/, 'the hidden PDF window partition must be in memory');

console.log(`ipc bridge contract ok — ${invoked.size} invoke, ${sent.size} send, ${listened.size} listen channels all wired`);
