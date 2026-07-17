import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-animatics-smoke-'));
const child = spawn(electron, ['.', '--remote-debugging-port=0', `--user-data-dir=${profile}`], {
  cwd: root,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { stderr += chunk; });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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
    const handlers = pending.get(message.id);pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message)); else handlers.resolve(message.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;pending.set(id, { resolve, reject });socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  const response = await send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true });
  socket.close();
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
  return response.result.value;
}

const smokeExpression = String.raw`(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<100&&!window.RefBoard;attempt++)await wait(50);
  if(!window.RefBoard)throw new Error('RefBoard API unavailable');
  const source=document.createElement('canvas');source.width=90;source.height=160;
  const sourceContext=source.getContext('2d');sourceContext.fillStyle='#e44747';sourceContext.fillRect(0,0,90,80);sourceContext.fillStyle='#357bd8';sourceContext.fillRect(0,80,90,80);
  const blob=await new Promise(resolve=>source.toBlob(resolve,'image/png'));
  await window.RefBoard.addImages([new File([blob],'portrait-smoke.png',{type:'image/png'})]);await wait(250);
  const item=window.RefBoard.state.items.filter(entry=>(entry.kind||'image')==='image').at(-1);
  if(!item)throw new Error('Smoke image was not added');
  item.crop={l:.1,t:.2,r:.9,b:.8};item.rot=90;item.w=90;item.h=160;item.flipX=true;item.gray=true;
  window.RefBoard.animatics.open([item]);await wait(300);
  const savedProject=window.RefBoard.animatics.serialize(),rotatedClip=savedProject.clips.at(-1);
  const imported={...rotatedClip.boardTransform,sourceAssetKey:rotatedClip.sourceAssetKey};
  const viewer=document.querySelector('#anViewer'),edgePixel=[...viewer.getContext('2d').getImageData(Math.round(viewer.width*.05),Math.round(viewer.height*.5),1,1).data];
  window.RefBoard.animatics.close();window.RefBoard.animatics.clear();window.RefBoard.animatics.load(savedProject,new Map());window.RefBoard.animatics.open();await wait(200);
  const reloaded=window.RefBoard.animatics.serialize().clips.at(-1).boardTransform;
  window.RefBoard.animatics.close();window.RefBoard.animatics.clear();item.rot=0;item.flipX=false;item.gray=false;
  window.RefBoard.animatics.open([item]);await wait(250);document.querySelector('#anFrameFill').click();await wait(100);
  return {
    imported,
    reloaded,
    edgePixel,
    fillScale:document.querySelector('#anFrameScaleVal')?.textContent,
    noPositionFields:!document.querySelector('#anTextX')&&!document.querySelector('#anTextY'),
    rotationStep:document.querySelector('#anTextRotation')?.step,
    selectionPath:document.querySelector('[data-an-tool="select"] path')?.getAttribute('d'),
    workspaceOpen:document.querySelector('#animaticsWorkspace')?.classList.contains('open'),
  };
})()`;

try {
  const result = await evaluate(await debuggerPort(), smokeExpression);
  assert.deepEqual(result.imported.crop, { l:.1, t:.2, r:.9, b:.8 });
  assert.equal(result.imported.rotation, 90);
  assert.equal(result.imported.flipX, true);
  assert.equal(result.imported.gray, true);
  assert.ok(result.imported.sourceAssetKey, 'transformed still must have a stable asset key');
  const { sourceAssetKey, ...importedTransform } = result.imported;
  assert.deepEqual(result.reloaded,importedTransform,'board transform must survive save and reopen');
  assert.ok(result.edgePixel[0]>10&&result.edgePixel[3]===255, 'rotated 9:16 still must fill the landscape viewer width');
  assert.ok(Math.abs(result.edgePixel[0]-result.edgePixel[1])<=1&&Math.abs(result.edgePixel[1]-result.edgePixel[2])<=1, 'board grayscale must render in Animatics');
  assert.equal(result.fillScale, '316%', 'Fill must display effective portrait-to-landscape scaling');
  assert.equal(result.noPositionFields, true);
  assert.equal(result.rotationStep, '1');
  assert.equal(result.selectionPath, 'M5 3l14 7.5-6 .75L9 20l-1.5-6.5L5 3z');
  assert.equal(result.workspaceOpen, true);
  console.log('animatics Electron transform smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await rm(profile, { recursive:true, force:true });
}
