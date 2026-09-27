import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Exercise the real IPC handlers and board files. Electron startup and shell
// notifications are stubbed; gates make the filesystem races deterministic.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../main.js', import.meta.url));
const container = require('./scripts/board-container');
const handlers = new Map();
const gates = new Map();
let forceCompact = false;
let failIndexWrite = false;
const checkpoint = async name => { await gates.get(name)?.(); };
const pause = name => {
  let arrived, resume;
  const entered = new Promise(resolve => { arrived = resolve; });
  const released = new Promise(resolve => { resume = resolve; });
  gates.set(name, async () => { arrived(); await released; });
  return { entered, release: () => { gates.delete(name); resume(); } };
};
const wrappedContainer = {
  ...container,
  async openContainer(...args) {
    await checkpoint('open');
    const box = await container.openContainer(...args);
    box.handle = new Proxy(box.handle, {
      get(handle, key) {
        if (key === 'truncate') return async (...values) => {
          await checkpoint('rollback');
          return handle.truncate(...values);
        };
        const value = Reflect.get(handle, key);
        return typeof value === 'function' ? value.bind(handle) : value;
      },
    });
    return box;
  },
  async appendContainerImage(...args) {
    await checkpoint('append');
    return container.appendContainerImage(...args);
  },
  async writeContainerIndex(...args) {
    await checkpoint('index');
    if (failIndexWrite) throw new Error('Simulated index failure');
    return container.writeContainerIndex(...args);
  },
  shouldCompactContainer: (...args) => forceCompact || container.shouldCompactContainer(...args),
  async rebuildContainer(...args) {
    await checkpoint('compact');
    return container.rebuildContainer(...args);
  },
};
const electron = {
  app: { requestSingleInstanceLock: () => true, on() {}, whenReady: () => ({ then() {} }) },
  ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
};
const source = await fs.readFile(new URL('../main.js', import.meta.url), 'utf8');
vm.runInNewContext(`${source}\nsetupIpc();`, {
  require: id => {
    if (id === 'electron') return electron;
    if (id === 'electron-updater') return { autoUpdater: {} };
    if (id === './scripts/win32-shell-notify') return { refreshShellIcons() {} };
    if (id === './scripts/board-container') return wrappedContainer;
    return require(id);
  },
  __dirname: root,
  // Exercise Windows case aliases on every CI platform, without modifying any
  // process globals or asking a case-sensitive filesystem to resolve an alias.
  process: { ...process, platform: 'win32' },
  Buffer, console, setTimeout, clearTimeout,
}, { filename: 'main.js' });

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'refboard-save-concurrency-'));
const target = path.join(dir, 'race.refboard');
const otherTarget = path.join(dir, 'other.refboard');
const owner = { sender: { id: 1 } };
const otherOwner = { sender: { id: 2 } };
const call = (name, arg, event = owner) => handlers.get(name)(event, arg);
const begin = (filePath = target, imageRefs = [], event = owner) => call('begin-board-save', {
  filePath, core: { app: 'refboard', items: [] }, imageRefs,
}, event);
const finish = session => call('finish-board-save', session.token);
const abort = session => call('abort-board-save', session.token);
const expectBusy = () => assert.rejects(begin(target, [], otherOwner), /Board save in progress/);
async function readSaved() {
  const box = await container.openContainer(target, { write: false });
  try {
    return await Promise.all(box.index.images.map(async image => ({
      id: image.id,
      bytes: (await container.readContainerImage(box.handle, image, box.size)).toString(),
    })));
  } finally { await box.handle.close(); }
}

try {
  const initial = await container.openContainer(target, { create: true });
  await container.writeContainerIndex(initial, { items: [] }, null, []);
  await initial.handle.close();
  const backup = `${target}.bak`;
  await fs.writeFile(backup, 'old-release-backup');

  const opening = pause('open');
  const pendingBegin = begin(target, [{ id: 'A', type: 'image/png' }]);
  await opening.entered;
  await expectBusy();
  await assert.rejects(begin(target.toUpperCase(), [], otherOwner), /Board save in progress/);
  assert.equal((await call('rename-recent-work', { filePath: target, name: 'renamed' })).reason, 'busy');
  opening.release();
  const a = await pendingBegin;

  // Reserving one board does not block a different board or renderer.
  const independent = await begin(otherTarget, [], otherOwner);
  await call('abort-board-save', independent.token, otherOwner);

  const appending = pause('append');
  const pendingAppend = call('append-board-save-image', {
    token: a.token, image: { id: 'A', type: 'image/png' }, data: Buffer.from('AAAA'),
  });
  await appending.entered;
  await assert.rejects(call('append-board-save-images', { token: a.token, images: [] }), /Board save in progress/);
  await assert.rejects(finish(a), /Board save in progress/);
  await assert.rejects(abort(a), /Board save in progress/);
  appending.release();
  await pendingAppend;

  const committing = pause('index');
  const pendingFinish = finish(a);
  await committing.entered;
  assert.equal(await fs.readFile(backup, 'utf8'), 'old-release-backup', 'backup stays until the save commits');
  await expectBusy();
  await assert.rejects(call('save-board-file', { filePath: target, data: 'overwrite' }), /Board save in progress/);
  await assert.rejects(call('write-board-preview', { filePath: target, preview: 'YQ==' }), /Board save in progress/);
  assert.equal((await abort(a)).aborted, false, 'a finishing token cannot be aborted');
  committing.release();
  assert.equal((await pendingFinish).saved, true);
  assert.deepEqual(await readSaved(), [{ id: 'A', bytes: 'AAAA' }]);
  await assert.rejects(fs.stat(backup), { code: 'ENOENT' }, 'successful incremental save removes a leftover backup');

  await fs.writeFile(backup, 'keep-on-failure');
  const b = await begin();
  await call('append-board-save-image', {
    token: b.token, image: { id: 'B' }, data: Buffer.from('BBBB'),
  });
  const aborting = pause('rollback');
  const pendingAbort = abort(b);
  await aborting.entered;
  await expectBusy();
  aborting.release();
  assert.equal((await pendingAbort).aborted, true);
  assert.deepEqual(await readSaved(), [{ id: 'A', bytes: 'AAAA' }], 'abort preserves the previous committed board');
  assert.equal(await fs.readFile(backup, 'utf8'), 'keep-on-failure', 'aborting must keep existing recovery data');

  // A failed commit must hold its reservation while rollback is still pending,
  // and release it afterward so the user can retry.
  const failed = await begin();
  const rollingBack = pause('rollback');
  failIndexWrite = true;
  const pendingFailure = assert.rejects(finish(failed), /Simulated index failure/);
  await rollingBack.entered;
  await expectBusy();
  rollingBack.release();
  await pendingFailure;
  failIndexWrite = false;
  assert.equal(await fs.readFile(backup, 'utf8'), 'keep-on-failure', 'a failed commit must not delete the backup');
  assert.deepEqual(await readSaved(), [{ id: 'A', bytes: 'AAAA' }]);

  const compacted = await begin(target, [{ id: 'A', type: 'image/png' }]);
  forceCompact = true;
  const compacting = pause('compact');
  const pendingCompaction = finish(compacted);
  await compacting.entered;
  await expectBusy();
  compacting.release();
  assert.equal((await pendingCompaction).compacted, true);
  forceCompact = false;
  assert.deepEqual(await readSaved(), [{ id: 'A', bytes: 'AAAA' }]);
  await assert.rejects(fs.stat(backup), { code: 'ENOENT' }, 'successful compaction also cleans up the old backup');

  // Preview backfills also mutate the container and must exclude saves in the
  // opposite direction, including the initial asynchronous open.
  const previewOpening = pause('open');
  await fs.writeFile(backup, 'old-preview-backup');
  const pendingPreview = call('write-board-preview', { filePath: target, preview: 'YQ==' });
  await previewOpening.entered;
  await expectBusy();
  previewOpening.release();
  assert.equal((await pendingPreview).written, true);
  await assert.rejects(fs.stat(backup), { code: 'ENOENT' }, 'successful preview updates clean up old backups');
  const retry = await begin();
  await abort(retry);

  // Failed initialization cannot permanently reserve a path.
  const missingDirTarget = path.join(dir, 'missing', 'new.refboard');
  await assert.rejects(begin(missingDirTarget), /ENOENT/);
  await fs.mkdir(path.dirname(missingDirTarget));
  const recovered = await begin(missingDirTarget);
  await abort(recovered);

  // The fallback whole-file save also uses a flushed temporary replacement.
  const rawTarget = path.join(dir, 'raw.refboard');
  await fs.writeFile(rawTarget, 'original');
  await fs.writeFile(`${rawTarget}.bak`, 'older');
  await assert.rejects(call('save-board-file', { filePath: rawTarget, data: undefined }));
  assert.equal(await fs.readFile(rawTarget, 'utf8'), 'original');
  assert.equal(await fs.readFile(`${rawTarget}.bak`, 'utf8'), 'older');
  assert.equal((await call('save-board-file', { filePath: rawTarget, data: 'updated' })).saved, true);
  assert.equal(await fs.readFile(rawTarget, 'utf8'), 'updated');
  await assert.rejects(fs.stat(`${rawTarget}.bak`), { code: 'ENOENT' });
  assert.ok(!(await fs.readdir(dir)).some(name => name.startsWith('raw.refboard.saving-')));
  console.log('board save concurrency passed — pending begin, case aliases, append, commit, abort, rollback, compaction, preview, and retry');
} finally {
  for (const name of [...gates.keys()]) gates.delete(name);
  await fs.rm(dir, { recursive: true, force: true });
}
