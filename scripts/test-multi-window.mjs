import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const preload = await readFile(new URL('../preload.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

// Window registry: multiple board windows are tracked, capped, and resolved per-event.
assert.match(main, /const windows = new Set\(\);/, 'all board windows must be tracked in a registry');
assert.match(main, /const MAX_BOARD_WINDOWS = 4;/, 'at most 4 board windows may stay open');
assert.match(main, /function windowForEvent\(event\)/, 'IPC dialogs must resolve the calling window from the event');
assert.match(main, /function focusedWindow\(\)/, 'a focused window fallback is required for global flows');

// Window creation is repeatable and self-cleaning.
assert.match(main, /async function createWindow\(startupFilePath = null\)/, 'createWindow must be reusable per board window');
assert.match(main, /win\.on\('closed', \(\) => \{[\s\S]*?windows\.delete\(win\);/, 'closing a window must drop it from the registry');
assert.match(main, /win\.webContents\.send\('open-board-path', startupFilePath\)/, 'a window can receive its initial board path after load');

// No single-global window may remain outside createWindow's local scope.
assert.doesNotMatch(main, /^let win =/m, 'the single global window reference must not return');
const windowLocalCreates = main.match(/const win = (?:new BrowserWindow|focusedWindow\(\))/g) || [];
assert.equal(windowLocalCreates.length, 3, 'win should only exist as a local inside createWindow/second-instance/open-file');

// Every modal dialog must attach to the calling window, never a shared global.
const dialogCalls = main.match(/dialog\.show(?:Save|Open)Dialog\(windowForEvent\(event\)/g) || [];
assert.equal(dialogCalls.length, 8, 'all 8 save/open dialogs stay parented to the calling window');
assert.doesNotMatch(main, /dialog\.show(?:Save|Open)Dialog\((win|null),/, 'no dialog may use a shared window parent');

// Per-window titlebar + close plumbing.
assert.match(main, /ipcMain\.on\('window-close', event => \{[\s\S]*?windowForEvent\(event\)[\s\S]*?send\('close-request'\)/, 'window close must target the requesting window');
assert.match(main, /ipcMain\.on\('close-confirmed', event => \{[\s\S]*?closing = true;[\s\S]*?windowForEvent\(event\)/, 'confirmed close must set the quit flag and close only its own window');
assert.match(main, /ipcMain\.on\('window-minimize', event => \{[\s\S]*?windowForEvent\(event\)/, 'minimize must target its own window');
assert.match(main, /ipcMain\.on\('window-maximize', event => \{[\s\S]*?windowForEvent\(event\)/, 'maximize must target its own window');
assert.match(main, /ipcMain\.handle\('window-is-maximized', event => \{[\s\S]*?windowForEvent\(event\)/, 'maximized state must be read per window');

// New-window IPC enforces the cap and reuses createWindow.
assert.match(main, /ipcMain\.handle\('open-board-window', async \(_, payload = \{\}\) => \{[\s\S]*?windows\.size >= MAX_BOARD_WINDOWS[\s\S]*?reason: 'window-limit'[\s\S]*?await createWindow\(filePath\)/, 'open-board-window must enforce the 4-window cap and spawn a real window');

// Shared notices reach every window; double-click focuses one window (no auto-spawn).
assert.match(main, /function notifyRenderer\(msg\) \{[\s\S]*?for \(const candidate of windows\)/, 'update/pin notices must broadcast to every board window');
assert.match(main, /app\.on\('second-instance',[\s\S]*?const win = focusedWindow\(\);[\s\S]*?win\.focus\(\);/, 'double-clicking a .refboard file must focus the existing window');
assert.match(main, /app\.on\('window-all-closed', \(\) => app\.quit\(\)\);/, 'the app must still quit once the last board window closes');

// Bridge + landing UI.
assert.match(preload, /openBoardInNewWindow: \(filePath = null\) => ipcRenderer\.invoke\('open-board-window', \{ filePath \}\)/, 'the isolated renderer bridge must expose new-window opening');
assert.match(html, /id="rwNewWindow"/, 'the landing screen must offer a New window button');
assert.match(html, /window\.RefBoardAPI\.openBoardInNewWindow\(\)/, 'the landing New window button must call the bridge');
assert.match(html, /r\?\.reason === 'window-limit'/, 'the renderer must surface the 4-window limit');

// Cross-window copy/paste must rebuild real image sources, not blank placeholders.
assert.match(html, /async function captureItemClipboardImages\(payload\)/, 'copy must capture per-image original pixels');
assert.match(html, /payload\.images = await captureItemClipboardImages\(payload\);/, 'copy must attach originals to the item payload');
assert.match(html, /images: j\.images && typeof j\.images === 'object' \? j\.images : null/, 'the item payload parser must carry embedded originals');
assert.match(html, /async function pasteItemsRehydratingImages\(payload, snap, pos\)/, 'cross-window paste must rehydrate missing images');
assert.match(html, /const info = payload\.images\?\.\[oldImgId\];/, 'paste must prefer each image\'s embedded original');
assert.match(html, /if \(!registered\) registered = await ensureComposite\(\);/, 'paste must fall back to the composite PNG when an original is unavailable');

// Shared IndexedDB must not delete another window's originals, and saves must recover.
assert.match(main, /ipcMain\.handle\('get-board-window-count'/, 'renderer must be able to ask how many board windows are open');
assert.match(preload, /getBoardWindowCount:/, 'bridge must expose the window count');
assert.match(html, /async function isMultiBoardWindow\(\)/, 'renderer must detect multi-window mode');
assert.match(html, /if \(await isMultiBoardWindow\(\)\) return;/, 'blob pruning must no-op while multiple windows share IndexedDB');
assert.match(html, /SESSION_META_KEY/, 'each window must keep its own session meta key');
assert.match(html, /async function ensureImageBlobForSave\(im\)/, 'saves must rebuild missing blobs from resident bitmaps');
assert.match(html, /const blob = await ensureImageBlobForSave\(im\);/, 'streamed board saves must use the recovery path');
assert.match(html, /if \(stored && im\.blob === blob && !\(await isMultiBoardWindow\(\)\)\) im\.blob = null;/, 'multi-window mode must keep resident originals for save');

console.log('multi-window contract tests passed');
