import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const preload = await readFile(new URL('../preload.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

assert.match(main, /WebContentsView/, 'split panes must be independent WebContentsView instances');
assert.match(main, /function layoutViews\(win\)/, 'the window must lay out primary and secondary views');
assert.match(main, /function boardPaneCount\(\)/, 'the 4-board cap must count split panes as well as windows');
assert.match(main, /ipcMain\.handle\('split-enter'/, 'main must create a secondary pane');
assert.match(main, /ipcMain\.handle\('split-exit'/, 'main must close the secondary pane through the unsaved handshake');
assert.match(main, /ipcMain\.on\('split-drag-move'/, 'main must resize panes while the divider is dragged');
assert.match(main, /pane: 'secondary'/, 'the right pane must load as pane=secondary');
assert.match(main, /SPLIT_RATIO_MIN = 0\.25/, 'the divider ratio must have a lower clamp');
assert.match(main, /SPLIT_RATIO_MAX = 0\.75/, 'the divider ratio must have an upper clamp');
assert.match(main, /pendingClose === 'split-exit'/, 'exiting split must reuse the close handshake on the right pane');
assert.match(main, /pendingClose === 'window'/, 'closing the window must ask the right pane first');

assert.match(preload, /splitEnter: \(ratio\) => ipcRenderer\.invoke\('split-enter', \{ ratio \}\)/, 'the bridge must expose split enter');
assert.match(preload, /splitExit: \(\) => ipcRenderer\.invoke\('split-exit'\)/, 'the bridge must expose split exit');
assert.match(preload, /splitDragMove: \(screenX\) => ipcRenderer\.send\('split-drag-move', \{ screenX \}\)/, 'the bridge must stream divider drags');
assert.match(preload, /onSplitStateChange: \(cb\) => ipcRenderer\.on\('split-state-changed'/, 'the bridge must forward split layout state');

assert.match(html, /id="minimapToggle"[\s\S]{0,400}?id="splitToggle"/, 'the split control must sit next to the minimap toggle');
assert.match(html, /id="splitDivider"/, 'the split edge must keep an invisible drag hit target');
assert.doesNotMatch(html, /#splitDivider::after/, 'the split edge must not show a visual drag handle');
assert.match(html, /html\.pane-secondary #titlebar,/, 'the right pane must not keep a second titlebar');
assert.match(html, /html\.pane-secondary #titlebarClose,/, 'the right pane must not keep a second close button');
assert.match(html, /html\.pane-secondary #rwNewWindow/, 'secondary panes must hide New window');
assert.match(html, /html\.pane-secondary #splitToggle/, 'secondary panes must not nest another split');
assert.match(html, /reason === 'split-exit' \? 'split'/, 'the split icon must ask to save before closing the right pane');
assert.match(html, /split: 'You still have unsaved changes in this pane/, 'closing split must prompt to save the right pane');
assert.match(main, /function splitFrame\(win\)/, 'split layout must know the full window and the right pane');
assert.match(main, /function startSplitAnim\(win, dir\)/, 'the right pane must slide in from the right');
assert.match(main, /width: frame\.w, height: frame\.h/, 'the main pane stays full width so its titlebar spans the window');
assert.match(main, /y: frame\.secY/, 'the right pane starts below the shared titlebar');
assert.match(html, /--split-left/, 'the left pane keeps its own width while the titlebar spans the window');
assert.match(html, /body\.split-active\.board-active:not\(\.titlebar-revealed\):not\(\.pane-secondary\) #selbar/, 'the left selection bar stays below the shared titlebar');
assert.match(main, /function animateSplitClose\(win\)/, 'closing split must slide the right pane back out');
assert.match(main, /reason: 'split-exit'/, 'closing split must run the unsaved handshake on the right pane');
assert.match(html, /const BOARD_PANE =/, 'the renderer must know whether it is the secondary pane');
assert.match(html, /splitRatio: 0\.5/, 'the divider ratio must persist as an app setting');
assert.match(html, /api\.splitEnter\(appSettings\.splitRatio\)/, 'entering split must send the remembered ratio');
assert.match(main, /function sendPaneActivity\(win\)/, 'main must track which pane the cursor is over');
assert.match(main, /startPaneActivityPolling\(win\)/, 'main must poll cursor position while split is active');
assert.match(main, /stopPaneActivityPolling\(win\)/, 'main must stop polling when split exits');
assert.match(preload, /onPaneActivity: \(cb\) => ipcRenderer\.on\('pane-activity'/, 'the bridge must forward pane activity state');
assert.match(html, /pane-dim/, 'the renderer must dim the inactive pane');
assert.match(main, /secondaryBoardReady/, 'pane dimming waits until the right board has finished opening');
assert.match(main, /blocked-board-path/, 'the right pane learns which board the left pane already has open');
assert.match(preload, /reportBoardSession: \(payload\) => ipcRenderer\.send\('board-session'/, 'a pane must report when its board is open');
assert.match(preload, /onBlockedBoardPath: \(cb\) => ipcRenderer\.on\('blocked-board-path'/, 'the right pane must hear the left pane board path');
assert.match(html, /function rejectBlockedBoard\(filePath\)/, 'the right pane must refuse the board already open on the left');
assert.match(html, /publishBoardSession\(true\)/, 'dimming starts only after the opened board finishes loading its images');

console.log('split-view contract tests passed');
