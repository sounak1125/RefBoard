import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

// An initialization failure must release the new file handle immediately:
// relying on garbage collection can lock boards on Windows or exhaust handles.
// Inject a filesystem into each module's VM instead of changing global fs.
const require = createRequire(import.meta.url);
const formats = [
  { file: './board-container.js', open: 'openContainer', size: 512 * 1024 },
  { file: './board-sidecar.js', open: 'openSidecarStore', size: 8 },
];
let cases = 0;

for (const format of formats) {
  const source = await readFile(new URL(format.file, import.meta.url), 'utf8');
  for (const mode of ['create-missing', 'truncate-existing', 'undersized-existing']) {
    for (const failure of [null, 'truncate', 'write', 'sync']) {
      for (const closeFails of failure ? [false, true] : [false]) {
        const label = `${format.open}: ${mode}, ${failure || 'success'}, closeFails=${closeFails}`;
        const expectedError = Object.assign(new Error(`Injected ${failure} failure`), { code: 'ENOSPC' });
        const calls = { open: [], truncate: 0, write: 0, sync: 0, close: 0 };
        const handle = {
          async stat() { return { size: 1 }; },
          async truncate() {
            calls.truncate++;
            if (failure === 'truncate') throw expectedError;
          },
          async write(_buffer, _offset, length) {
            calls.write++;
            if (failure === 'write') throw expectedError;
            return { bytesWritten: length };
          },
          async sync() {
            calls.sync++;
            if (failure === 'sync') throw expectedError;
          },
          async close() {
            calls.close++;
            if (closeFails) throw new Error('Injected close failure');
          },
        };
        const filesystem = {
          async open(_target, flags) {
            calls.open.push(flags);
            if (mode === 'create-missing' && calls.open.length === 1) {
              throw Object.assign(new Error('Missing fixture'), { code: 'ENOENT' });
            }
            return handle;
          },
        };
        const module = { exports: {} };
        vm.runInNewContext(source, {
          module, Buffer,
          require: id => id === 'fs/promises' ? filesystem : require(id),
        }, { filename: format.file });
        const options = mode === 'truncate-existing' ? { truncate: true } : { create: true };
        const pending = module.exports[format.open]('handle-test.refboard', options);

        if (failure) {
          await assert.rejects(pending, error => error === expectedError, `${label}: preserve the initialization error`);
          assert.equal(calls.close, 1, `${label}: close the failed handle exactly once`);
          if (failure === 'truncate') assert.equal(calls.write, 0, `${label}: stop before writing`);
          if (failure !== 'sync') assert.equal(calls.sync, 0, `${label}: stop before syncing`);
        } else {
          const opened = await pending;
          assert.equal(opened.handle, handle, `${label}: return the caller's handle`);
          assert.equal(opened.size, format.size, `${label}: initialize the format header`);
          assert.equal(calls.sync, 1, `${label}: flush initialization`);
          assert.equal(calls.close, 0, `${label}: successful handle remains caller-owned`);
          await opened.handle.close();
          assert.equal(calls.close, 1, `${label}: caller can close the handle`);
        }
        assert.equal(calls.truncate, 1, `${label}: initialization runs once`);
        assert.deepEqual(calls.open, mode === 'create-missing' ? ['r+', 'w+']
          : mode === 'truncate-existing' ? ['w+'] : ['r+'], `${label}: expected open path`);
        cases++;
      }
    }
  }
}

console.log(`board open handle lifecycle tests passed (${cases} cases)`);
