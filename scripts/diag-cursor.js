'use strict';
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, '..', 'preload.js') },
  });

  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  const r = await win.webContents.executeJavaScript(`(async () => {
    const png = await fetch('assets/cursor-pointer.png');
    const png2 = await fetch('assets/cursor-pointer@2x.png');
    return {
      png: { status: png.status, ok: png.ok, url: png.url },
      png2: { status: png2.status, ok: png2.ok, url: png2.url },
      body: getComputedStyle(document.body).cursor.slice(0, 120),
      board: getComputedStyle(document.getElementById('board')).cursor.slice(0, 120),
      tb: getComputedStyle(document.querySelector('#toolbar .tb')).cursor.slice(0, 120),
      usesImageSet: /image-set/i.test(getComputedStyle(document.body).cursor),
      jsConst: CURSOR_POINTER,
    };
  })()`);
  console.log(JSON.stringify(r, null, 2));
  app.quit();
});
