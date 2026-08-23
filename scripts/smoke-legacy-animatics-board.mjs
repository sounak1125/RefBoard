/**
 * Legacy board compatibility smoke test.
 *
 * Boards written by RefBoard <= 2.0.6 embed an `animatics` timeline in the
 * core payload and stream its audio/video media through the same `images[]`
 * array the board images use. The timeline was removed in the release after
 * 2.0.6, so this test pins the two things that must still hold:
 *
 *   1. Such a board opens, with every board image restored.
 *   2. The audio/video records are skipped, not decoded as board images.
 *
 * Regressing either one silently corrupts or drops a user's existing board.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { boardHeaderPrefix, boardImageParts } = require('./board-save-format.js');
const { scanBoardFile } = require('./board-open-stream.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-legacy-anim-'));
const boardPath = path.join(profile, 'legacy-animatics.refboard');

const BOARD_IMAGES = 3;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/* ---------- build a 2.0.6-shaped board file ---------- */

// 1x1 PNG, and token audio/video payloads. Only the record `type` matters for
// the skip branch under test, so the media bytes stay deliberately tiny.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const items = [];
const images = [];
for (let i = 0; i < BOARD_IMAGES; i++) {
  const id = `img-${i + 1}`;
  items.push({
    id: `item-${i + 1}`, kind: 'image', imgId: id, name: `${id}.png`,
    x: i * 120, y: 0, w: 100, h: 100, rot: 0,
    flipX: false, flipY: false, gray: false,
    crop: { l: 0, t: 0, r: 1, b: 1 }, groupId: null,
  });
  images.push({ rec: { id, type: 'image/png', name: `${id}.png`, w: 1, h: 1, size: PNG_1X1.length }, bytes: PNG_1X1 });
}

// Animatics media rode along in images[] with audio/video mime types.
images.push({
  rec: { id: 'media-audio-1', type: 'audio/wav', name: 'track.wav', w: 0, h: 0, size: 8 },
  bytes: Buffer.from('RIFF0000', 'ascii'),
});
images.push({
  rec: { id: 'media-video-1', type: 'video/mp4', name: 'clip.mp4', w: 0, h: 0, size: 8 },
  bytes: Buffer.from('ftypmp42', 'ascii'),
});

const core = {
  app: 'refboard',
  version: 3,
  view: { tx: 0, ty: 0, s: 1 },
  boardGray: false,
  snapEnabled: false,
  gridAppearance: 'dots',
  animatics: {
    sequenceDuration: 12,
    videoTracks: 2,
    audioTracks: 1,
    clips: [{ id: 'clip-1', itemId: 'item-1', track: 0, start: 0, duration: 3 }],
    texts: [{ id: 'text-1', track: 1, start: 0, duration: 2, text: 'legacy' }],
    audio: [{ id: 'aud-1', mediaId: 'media-audio-1', track: 0, start: 0, duration: 4 }],
  },
  items,
};

const handle = await open(boardPath, 'w');
try {
  await handle.write(boardHeaderPrefix(core, null));
  let first = true;
  for (const { rec, bytes } of images) {
    const parts = boardImageParts(rec, bytes);
    await handle.write((first ? '' : ',') + parts.prefix);
    await handle.write(parts.base64);
    await handle.write(parts.suffix);
    first = false;
  }
  await handle.write(']}');
} finally {
  await handle.close();
}

// The fixture must genuinely look like a legacy board before it proves anything.
const written = JSON.parse(await readFile(boardPath, 'utf8'));
assert.ok(written.animatics, 'fixture should carry a legacy animatics timeline');
assert.equal(written.images.length, BOARD_IMAGES + 2, 'fixture should embed board images plus animatics media');
const scanned = await scanBoardFile(boardPath);
assert.equal(scanned.images.length, BOARD_IMAGES + 2, 'streaming scanner should see every embedded record');

/* ---------- open it in a real window ---------- */

const child = spawn(electron, ['.', '--remote-debugging-port=0', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion', `--user-data-dir=${profile}`], {
  cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });

async function debuggerPort() {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Electron exited before smoke setup (${child.exitCode})\n${stderr}`);
    try {
      const [port] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
      if (/^\d+$/.test(port)) return Number(port);
    } catch { /* wait for Chromium */ }
    await delay(100);
  }
  throw new Error(`Electron debugging port did not become ready\n${stderr}`);
}

async function evaluate(port, expression) {
  let targets = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    try { targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json()); } catch { /* retry */ }
    if (targets.some(entry => entry.type === 'page')) break;
    await delay(100);
  }
  const target = targets.find(entry => entry.type === 'page' && /RefBoard|index\.html/i.test(`${entry.title} ${entry.url}`))
    || targets.find(entry => entry.type === 'page');
  if (!target) throw new Error('RefBoard page target was not available');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id); pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message)); else handlers.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  socket.close();
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

const smokeExpression = `(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const filePath=${JSON.stringify(boardPath)};
  for(let attempt=0;attempt<100&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  const errors=[];
  const priorError=console.error;
  console.error=(...args)=>{errors.push(args.map(String).join(' '));priorError(...args);};
  document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
  const pending=window.RefBoard.openBoardFromPath(filePath);
  let stopped=false;
  const confirmer=(async()=>{
    while(!stopped){
      const ok=document.querySelector('#confirmModal.show #confirmOk');
      if(ok){ok.click();return;}
      await wait(40);
    }
  })();
  await pending;
  stopped=true;
  await confirmer;
  for(let attempt=0;attempt<80;attempt++){
    if(!document.querySelector('#openingOverlay')?.classList.contains('show'))break;
    await wait(50);
  }
  await wait(200);
  console.error=priorError;
  const items=window.RefBoard.state.items;
  return {
    boardActive:document.body.classList.contains('board-active'),
    imageItems:items.filter(it=>(it.kind||'image')==='image').length,
    totalItems:items.length,
    imageRecords:window.RefBoard.images.size,
    recordTypes:[...window.RefBoard.images.values()].map(im=>im.type),
    errors,
  };
})()`;

try {
  const result = await evaluate(await debuggerPort(), smokeExpression);
  assert.equal(result.boardActive, true, 'a legacy animatics board should open into the board view');
  assert.equal(result.imageItems, BOARD_IMAGES, `every board image should survive (found ${result.imageItems})`);
  assert.equal(result.totalItems, BOARD_IMAGES, 'no extra items should appear for the dropped timeline');
  assert.equal(result.imageRecords, BOARD_IMAGES, `audio/video records must be skipped, not registered as images (found ${result.imageRecords})`);
  assert.ok(
    result.recordTypes.every(type => String(type).startsWith('image/')),
    `no audio/video blob may become a board image (got ${result.recordTypes.join(', ')})`,
  );
  assert.deepEqual(result.errors, [], `opening a legacy board must not log errors (${result.errors.join(' | ')})`);
  console.log('legacy animatics board compatibility smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
