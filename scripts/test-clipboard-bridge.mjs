import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

export const NOTE_CLIP_FORMAT = 'electron application/osclipboard;format="application/x-refboard-note+json"';

// Register the actual production handlers without starting the application or
// touching the system clipboard. The Electron smoke uses this same extraction.
export async function loadClipboardBridge({ clipboard, ClipboardItem, nativeImage }) {
  const source = await readFile(new URL('../main.js', import.meta.url), 'utf8');
  const start = source.indexOf("  ipcMain.handle('clipboard-read-image'");
  const end = source.indexOf("  ipcMain.handle('open-external'", start);
  assert.ok(start >= 0 && end > start, 'clipboard IPC registration must be present');
  const handlers = new Map();
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    clipboard, ClipboardItem, nativeImage, Buffer, Blob,
  });
  assert.equal(handlers.size, 3);
  return {
    readImage: handlers.get('clipboard-read-image'),
    writeNotes: payload => handlers.get('clipboard-write-notes')(null, payload),
    readNotes: handlers.get('clipboard-read-notes'),
  };
}

async function run() {
  class ClipboardItem {
    constructor(entries) { this.entries = entries; this.types = Object.keys(entries); }
    async getType(type) {
      assert.ok(this.types.includes(type), 'getType must request an advertised type');
      const value = await this.entries[type];
      return typeof value === 'string' ? new Blob([value], { type }) : value;
    }
  }
  let items = [];
  let readError = null;
  let writeError = null;
  let finishWrite = null;
  const writes = [];
  const decoded = [];
  const bridge = await loadClipboardBridge({
    ClipboardItem,
    clipboard: {
      async read() { if (readError) throw readError; return items; },
      async write(next) {
        writes.push(next);
        if (writeError) throw writeError;
        if (finishWrite) await finishWrite;
        items = next;
      },
    },
    nativeImage: {
      createFromBuffer(buffer) {
        decoded.push(buffer.toString());
        return {
          isEmpty: () => buffer.toString() === 'invalid-image',
          toPNG: () => Buffer.from('normalized-png'),
        };
      },
    },
  });

  const payload = JSON.stringify({ app: 'refboard', kind: 'note-clipboard', items: [{ text: 'Hello, 世界' }] });
  let release;
  finishWrite = new Promise(resolve => { release = resolve; });
  let completed = false;
  const pending = bridge.writeNotes({ payload, plainText: 'Hello, 世界' }).then(value => { completed = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false, 'copy must wait until the native write commits');
  assert.equal(writes.length, 1, 'text and structured notes must be committed atomically');
  assert.equal(writes[0].length, 1);
  assert.deepEqual(writes[0][0].types.sort(), [NOTE_CLIP_FORMAT, 'text/plain'].sort());
  assert.equal(await (await writes[0][0].getType('text/plain')).text(), 'Hello, 世界');
  assert.equal(await (await writes[0][0].getType(NOTE_CLIP_FORMAT)).text(), payload);
  release();
  assert.equal((await pending).ok, true);
  finishWrite = null;
  assert.equal(await bridge.readNotes(), payload, 'native raw format must round-trip unchanged');

  items = [new ClipboardItem({ 'text/plain': 'ordinary text' })];
  assert.equal(await bridge.readNotes(), null);
  items = [];
  assert.equal(await bridge.readNotes(), null);
  assert.equal(await bridge.readImage(), null);
  assert.equal((await bridge.writeNotes()).ok, true);
  assert.equal(await bridge.readNotes(), '');

  writeError = new Error('clipboard busy');
  assert.equal((await bridge.writeNotes({ payload })).ok, false);
  writeError = null;
  readError = new Error('clipboard unavailable');
  assert.equal(await bridge.readNotes(), null);
  await assert.rejects(bridge.readImage(), /clipboard unavailable/);
  readError = null;
  items = [{ types: [NOTE_CLIP_FORMAT], getType: async () => { throw new Error('format unavailable'); } }];
  assert.equal(await bridge.readNotes(), null);
  items = [{ types: [NOTE_CLIP_FORMAT], getType: async () => ({ text: async () => { throw new Error('blob read failed'); } }) }];
  assert.equal(await bridge.readNotes(), null, 'asynchronous Blob decoding failures must use the null fallback');

  // Image reads prefer PNG and normalize other supported images to PNG bytes.
  items = [new ClipboardItem({
    'text/plain': 'image caption',
    'image/jpeg': new Blob(['jpeg-source']),
    'image/png': new Blob(['png-source']),
  })];
  assert.equal(await bridge.readImage(), Buffer.from('normalized-png').toString('base64'));
  assert.equal(decoded.at(-1), 'png-source');
  items = [new ClipboardItem({ 'image/jpeg': new Blob(['jpeg-source']) })];
  assert.equal(await bridge.readImage(), Buffer.from('normalized-png').toString('base64'));
  assert.equal(decoded.at(-1), 'jpeg-source');
  items = [
    new ClipboardItem({ 'image/png': new Blob(['invalid-image']) }),
    new ClipboardItem({ 'text/plain': 'skip this item' }),
    new ClipboardItem({ 'image/png': new Blob(['valid-image']) }),
  ];
  assert.equal(await bridge.readImage(), Buffer.from('normalized-png').toString('base64'));
  assert.equal(decoded.at(-1), 'valid-image');
  items = [new ClipboardItem({ 'image/png': new Blob(['invalid-image']) })];
  assert.equal(await bridge.readImage(), null);
  console.log('clipboard bridge tests passed');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await run();
