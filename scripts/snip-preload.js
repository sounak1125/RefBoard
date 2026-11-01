'use strict';
/* Preload for the snip overlay windows only. They show a frozen screen and
   report a rectangle; they get these four channels and nothing of RefBoardAPI. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('SnipAPI', {
  init: () => ipcRenderer.invoke('snip-overlay-init'),
  ready: () => ipcRenderer.send('snip-overlay-ready'),
  finish: (points) => ipcRenderer.send('snip-overlay-finish', points),
  cancel: () => ipcRenderer.send('snip-overlay-cancel'),
});
