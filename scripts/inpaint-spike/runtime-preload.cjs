'use strict';
// Lets the spike page hand its measurements back to lama-runtime-spike.cjs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('spike', {
  report: result => ipcRenderer.send('spike-report', result),
});
