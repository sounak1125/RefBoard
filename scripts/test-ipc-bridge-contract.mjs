import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
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
const emitted = inMain(/(?:webContents|sender)\.send\('([^']+)'/g);

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

console.log(`ipc bridge contract ok — ${invoked.size} invoke, ${sent.size} send, ${listened.size} listen channels all wired`);
