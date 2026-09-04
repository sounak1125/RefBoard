/**
 * Proves an abandoned or failed streamed save leaves nothing behind.
 *
 * Runs the real app and drives the save IPC directly: begin a save, abort it,
 * and check that the temp file is gone, the board file was never created, and
 * a second abort is a quiet no-op. Then begin a save into a directory that does
 * not exist and check the error that comes back is the filesystem's, not a
 * ReferenceError from the cleanup helper (which is what 2.0.6–2.0.12 returned).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeProfileDir } from './smoke-profile-cleanup.mjs';
import { evaluate } from './smoke-cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const profile = await mkdtemp(path.join(os.tmpdir(), 'refboard-save-abort-smoke-'));
const boardDir = path.join(profile, 'boards');
const boardPath = path.join(boardDir, 'abort-smoke.refboard');
const missingDirPath = path.join(profile, 'does-not-exist', 'nope.refboard');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const { mkdir } = await import('node:fs/promises');
await mkdir(boardDir, { recursive: true });

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

const smokeExpression = `(async()=>{
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  for(let attempt=0;attempt<100&&!window.RefBoardAPI;attempt++)await wait(50);
  if(!window.RefBoardAPI)throw new Error('RefBoardAPI bridge unavailable');
  for(let attempt=0;attempt<300&&!(window.RefBoard&&window.RefBoard.startupComplete);attempt++)await wait(50);
  const api=window.RefBoardAPI;
  const core={version:3,items:[],boardGray:false};

  const begun=await api.beginBoardSave('abort-smoke.refboard',${JSON.stringify(boardPath)},core,null);
  if(!begun||!begun.started)throw new Error('begin-board-save did not start a session');
  await api.appendBoardSaveImages(begun.token,[]);
  const aborted=await api.abortBoardSave(begun.token);
  const abortedAgain=await api.abortBoardSave(begun.token);

  let beginError='';
  try{ await api.beginBoardSave('nope.refboard',${JSON.stringify(missingDirPath)},core,null); }
  catch(e){ beginError=String((e&&e.message)||e); }

  return {token:begun.token,aborted,abortedAgain,beginError};
})()`;

try {
  const port = await debuggerPort();
  const result = await evaluate(port, smokeExpression);

  assert.deepEqual(result.aborted, { aborted: true }, 'abort of a live session must report aborted');
  assert.deepEqual(result.abortedAgain, { aborted: false }, 'abort of an unknown token must be a no-op, not a throw');

  const leftovers = (await readdir(boardDir)).filter(name => name.includes('.saving-'));
  assert.deepEqual(leftovers, [], `abort must remove the temp file, found: ${leftovers.join(', ')}`);
  await assert.rejects(stat(boardPath), 'an aborted save must not create the board file');

  assert.ok(result.beginError, 'begin-board-save into a missing directory must fail');
  assert.doesNotMatch(result.beginError, /discardBoardSaveSession|is not defined/, 'the failure must not be the cleanup helper itself');
  assert.match(result.beginError, /ENOENT/, `the real filesystem error must surface, got: ${result.beginError}`);

  console.log('board save abort Electron smoke passed');
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => {});
  await removeProfileDir(profile);
}
