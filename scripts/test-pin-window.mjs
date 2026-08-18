import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const preload = await readFile(new URL('../preload.js', import.meta.url), 'utf8');
const zorder = await readFile(new URL('./win32-zorder.js', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const controls = html.match(/<div id="titlebarControls">([\s\S]*?)<\/div>\s*<\/header>/);
assert.ok(controls, 'titlebar controls should be present');
assert.match(controls[1], /id="titlebarPin"[\s\S]*id="titlebarMin"[\s\S]*id="titlebarMax"[\s\S]*id="titlebarClose"/,
  'the pin button must sit immediately before minimize');
assert.match(controls[1], /<button type="button" class="wc-btn" id="titlebarPin"/, 'the pin control must use the window-chrome button class');
assert.match(controls[1], /aria-haspopup="menu"/, 'the pin button must expose a menu');
assert.match(controls[1], /aria-pressed="false"/, 'the pin button must expose pressed state');
assert.match(html, /\.wc-btn\.pinned\{ color:var\(--acc\); \}/, 'a pinned pin button must use the accent color');

assert.match(html, /id="titlebarPinMenu"/, 'the pin menu must exist');
assert.match(html, /id="titlebarPinAlways"[\s\S]*Always on top/, 'the pin menu must include Always on top');
assert.match(html, /id="titlebarPinAbove"[\s\S]*Always on top of/, 'the pin menu must include Always on top of…');
assert.match(html, /id="titlebarPinWindows"/, 'the pin window list submenu must exist');
assert.match(html, /#titlebarPinWindows::-webkit-scrollbar-thumb/, 'the above-window list must use the RefBoard overlay scrollbar');
assert.match(html, /body\.classList\.add\('titlebar-pin-open'\)/, 'opening the pin menu must keep the title bar revealed');
assert.match(
  html,
  /e\.target\.closest\('\.modal, #toolbar, #ctxmenu, #drawPanelWrap, #addPanelWrap, #drawCanvasPop, #drawColorPop, #titlebarPin, #titlebarPinMenu, #titlebarPinWindows'\)\) return/,
  'wheel over the pin menus must scroll the window list instead of zooming the board',
);

assert.match(preload, /pinGetState: \(\) => ipcRenderer\.invoke\('pin-get-state'\)/, 'preload must expose pin state');
assert.match(preload, /pinSetAlways: \(\) => ipcRenderer\.invoke\('pin-set-always'\)/, 'preload must expose global pin');
assert.match(preload, /pinSetAbove: \(id\) => ipcRenderer\.invoke\('pin-set-above', \{ id \}\)/, 'preload must expose attach-to-window pin');
assert.match(preload, /pinListWindows: \(\) => ipcRenderer\.invoke\('pin-list-windows'\)/, 'preload must expose the window list');
assert.match(preload, /onPinStateChange: \(cb\) => ipcRenderer\.on\('pin-state-changed'/, 'preload must forward pin state changes');
assert.match(preload, /onPinOpenAbove: \(cb\) => ipcRenderer\.on\('pin-open-above'/, 'preload must forward the above-window shortcut');

assert.match(main, /ipcMain\.handle\('pin-get-state'/, 'main must serve pin state per window');
assert.match(main, /ipcMain\.handle\('pin-set-always'/, 'main must toggle global always-on-top');
assert.match(main, /ipcMain\.handle\('pin-set-above'/, 'main must attach above a chosen window');
assert.match(main, /ipcMain\.handle\('pin-list-windows'/, 'main must list candidate windows');
assert.match(main, /function pinAlways\(win\)/, 'Ctrl+T and the pin menu must share one always-on-top helper');
assert.match(main, /input\.control && !input\.alt && !input\.shift && key === 't'[\s\S]*?pinAlways\(win\)/,
  'Ctrl+T must still toggle always-on-top');
assert.match(main, /input\.control && input\.alt && input\.shift && key === 'a'[\s\S]*?pin-open-above/,
  'Ctrl+Alt+Shift+A must open the above-window picker');
assert.match(main, /require\('\.\/scripts\/win32-zorder'\)/, 'main must load the Windows z-order helper');

assert.match(zorder, /function listWindows/, 'the helper must enumerate top-level windows');
assert.match(zorder, /GWLP_HWNDPARENT/, 'the helper must support owner-window attach');
assert.match(zorder, /function restack/, 'the helper must restack above a target as a fallback');

assert.match(html, /label:'Always on top', keys:\['Ctrl','T'\]/, 'shortcuts must keep Ctrl+T for always on top');
assert.match(html, /label:'Always on top of…', keys:\['Ctrl','Alt','Shift','A'\]/, 'shortcuts must document the above-window chord');

assert.ok(pkg.dependencies?.koffi, 'koffi must be a runtime dependency for Win32 pin attach');
assert.ok(pkg.build?.files?.includes('scripts/win32-zorder.js'), 'the packaged app must include the z-order helper');
assert.ok((pkg.build?.asarUnpack || []).some(entry => entry.includes('koffi')), 'koffi must be unpacked from asar');

console.log('pin window contract tests passed');
