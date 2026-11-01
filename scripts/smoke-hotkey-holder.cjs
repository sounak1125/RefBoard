'use strict';
/* Smoke helper, not shipped: a second app that holds one global shortcut, so
   smoke-snip-shortcut.mjs can stage a real "in use by another app" conflict.
   Run as: electron scripts/smoke-hotkey-holder.cjs --hold=Control+Alt+J --user-data-dir=<tmp> */
const { app, globalShortcut } = require('electron');

const hold = (process.argv.find(arg => arg.startsWith('--hold=')) || '').slice('--hold='.length);
app.whenReady().then(() => {
  let ok = false;
  try { ok = globalShortcut.register(hold, () => {}); } catch { ok = false; }
  process.stdout.write(`HELD ${hold} ${ok}\n`);
});
app.on('will-quit', () => globalShortcut.unregisterAll());
