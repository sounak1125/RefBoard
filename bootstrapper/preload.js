'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Exposes window.RefBoardInstaller — the exact object your existing
// build/installer-ui/app.js already reaches for:
//   window.RefBoardInstaller.launch()
//   window.RefBoardInstaller.minimize()
//   window.RefBoardInstaller.close()
// plus the extras the bootstrapped flow needs:
//   window.RefBoardInstaller.start()            -> begins the real silent install
contextBridge.exposeInMainWorld('RefBoardInstaller', {
  // Begins the real NSIS silent install. Returns a promise that resolves when
  // the install process exits, including its success or failure result.
  start: () => ipcRenderer.invoke('installer:start'),

  // Launches the installed RefBoard and quits the bootstrapper.
  launch: () => ipcRenderer.invoke('installer:launch'),

  // Frameless window controls (data-window-action="minimize" / "close").
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close'),
});
