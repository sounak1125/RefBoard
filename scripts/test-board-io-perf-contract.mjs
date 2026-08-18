import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
const preload = await readFile(new URL('../preload.js', import.meta.url), 'utf8');

assert.match(main, /async function scanBoardHandle\(|scanBoardHandle\(handle,/, 'open sessions must scan from a reused file handle');
assert.match(main, /readBoardImageBytesFromHandle\(session\.handle/, 'single-image open reads must use the session handle');
assert.match(main, /ipcMain\.handle\('read-board-open-images'/, 'main must expose a batched open-image read');
assert.match(main, /ipcMain\.handle\('append-board-save-images'/, 'main must expose a batched save append');
assert.match(main, /await closeBoardOpenSession\(session\)/, 'finish-board-open must close the reused handle');

assert.match(preload, /readBoardOpenImages: \(token, indexes\) => ipcRenderer\.invoke\('read-board-open-images'/, 'preload must bridge batched open reads');
assert.match(preload, /appendBoardSaveImages: \(token, images\) => ipcRenderer\.invoke\('append-board-save-images'/, 'preload must bridge batched save appends');
assert.match(preload, /appendBoardSaveImage: \(token, image, data\) => ipcRenderer\.invoke\('append-board-save-image'/, 'single-image save append must remain available');

assert.match(html, /const BOARD_OPEN_IMAGE_CONCURRENCY = 4/, 'file open must batch image loads');
assert.match(html, /BOARD_SAVE_BATCH_MAX = 4/, 'saves must pack a small number of images per IPC');
assert.match(html, /BOARD_SAVE_BATCH_BYTES = 8 \* 1024 \* 1024/, 'save batches must also cap decoded bytes');
assert.match(html, /appendBoardSaveImages/, 'streamed saves must call the batched append');
assert.match(html, /readBoardOpenImages\(token, batch\.map\(rec => rec\.index\)\)/, 'desktop open must request a batch of image bytes');
assert.match(html, /void persistOpenedBoardBlobs\(persistSeq, pendingPersist\)/, 'IndexedDB persist must continue after the overlay hides');
assert.match(html, /pendingPersist = \[\.\.\.images\.values\(\)\]/, 'open must snapshot resident blobs before showing the board');
assert.match(html, /const targetPath = opts\.filePath \|\| currentBoardPath \|\| undefined/, 'saveBoardFile must accept an explicit path');
assert.match(html, /saveBoardFile,\s*openBoardFromPath/, 'smoke and tests must be able to drive save/open through window.RefBoard');

function extractFunction(name) {
  const start = html.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  const sigEnd = html.indexOf(') {', start);
  assert.ok(sigEnd > start, `${name} should have a body`);
  const brace = sigEnd + 1;
  let depth = 0;
  for (let i = brace; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  assert.fail(`${name} should have a complete body`);
}

const applyBody = extractFunction('applyBoardPayload');
assert.doesNotMatch(applyBody, /await persistImageBlob/, 'opening must not wait on IndexedDB before showing the board');
assert.match(applyBody, /hideOpeningOverlay\(\)/, 'the opening overlay still hides from applyBoardPayload');
assert.match(applyBody, /BOARD_OPEN_IMAGE_CONCURRENCY/, 'applyBoardPayload must load images in batches');

const saveBody = extractFunction('performBoardSave');
assert.match(saveBody, /appendBoardSaveImages/, 'performBoardSave must flush images through the batched IPC');
assert.match(saveBody, /ensureImageBlobForSave\(im\)/, 'batched saves must still recover missing blobs');

console.log('board I/O perf contract tests passed');
