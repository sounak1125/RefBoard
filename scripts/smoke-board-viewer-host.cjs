'use strict';
/**
 * A bare Electron window for scripts/smoke-board-viewer.mjs: opens one
 * exported Viewer (.html) or PDF the way a stranger's browser would, with
 * none of RefBoard around it.
 *
 *   electron scripts/smoke-board-viewer-host.cjs --open=<file> --log=<json>
 *     [--width=1280 --height=800] [--pdf] [--capture=<png> --delay=<ms>]
 *     --remote-debugging-port=0 --user-data-dir=<temp>
 *
 * The window is sandboxed, has no preload, and uses its own in-memory
 * partition. Every request the page makes is appended to --log, so the smoke
 * can prove a Viewer reaches nothing beyond its own file.
 */
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const arg = name => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const file = arg('open');
const log = arg('log');
const width = Number(arg('width')) || 1280;
const height = Number(arg('height')) || 800;
const pdf = process.argv.includes('--pdf');
const capture = arg('capture');
const captureDelay = Number(arg('delay')) || 2500;

app.whenReady().then(async () => {
  const ses = session.fromPartition(`viewer-smoke-${process.pid}`);
  const seen = [];
  ses.webRequest.onBeforeRequest((details, callback) => {
    seen.push({ url: details.url.startsWith('data:') ? details.url.slice(0, 40) : details.url, type: details.resourceType });
    if (log) fs.writeFileSync(log, JSON.stringify(seen));
    callback({});
  });
  if (log) fs.writeFileSync(log, '[]');
  const win = new BrowserWindow({
    width, height, show: true, useContentSize: true,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      partition: `viewer-smoke-${process.pid}`, plugins: pdf, backgroundThrottling: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await win.loadURL(pathToFileURL(path.resolve(file)).href);
  if (capture) {
    // The PDF viewer paints in its own frame, which a page screenshot misses;
    // capturePage takes the window as it is on screen.
    await new Promise(r => setTimeout(r, captureDelay));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(capture, image.toPNG());
    app.quit();
  }
});
app.on('window-all-closed', () => app.quit());
