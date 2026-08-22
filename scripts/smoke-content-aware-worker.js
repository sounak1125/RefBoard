'use strict';
/* Electron smoke for the content-aware fill worker.
 *
 * Node tests exercise the engine through vm.runInContext, which proves the
 * algorithms but not that the worker actually loads: importScripts resolution
 * under Electron's file:// origin, the message protocol, transferables, progress
 * and cancellation are only real in a browser context.
 *
 *   npx electron scripts/smoke-content-aware-worker.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const WATCHDOG_MS = 120000;

app.on('window-all-closed', () => app.quit());

function fail(message) {
  console.error(`FAIL: ${message}`);
  app.exit(1);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });

  const timer = setTimeout(() => fail('timed out'), WATCHDOG_MS);

  ipcMain.on('smoke-result', (_event, report) => {
    clearTimeout(timer);
    for (const line of report.log) console.log(`  ${line}`);
    if (report.errors.length) {
      for (const error of report.errors) console.error(`FAIL: ${error}`);
      app.exit(1);
      return;
    }
    console.log('content-aware fill worker smoke passed');
    app.exit(0);
  });

  await win.loadFile(path.join(__dirname, 'smoke-content-aware-worker.html'));
});
