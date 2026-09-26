'use strict';

// Run with electron scripts/smoke-clipboard-bridge.cjs. Never prints clipboard
// contents. Unsupported pre-existing formats cause a skip before any mutation.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, clipboard, ClipboardItem, nativeImage } = require('electron');

app.whenReady().then(async () => {
  let win;
  let saved;
  const savedPayloads = new Map();
  let changed = false;
  try {
    const { loadClipboardBridge, NOTE_CLIP_FORMAT } = await import('./test-clipboard-bridge.mjs');
    const original = await clipboard.read();
    const types = original.flatMap(item => item.types);
    if (process.argv.includes('--inspect-only')) {
      console.log(JSON.stringify({ electron: process.versions.electron, clipboardTypes: types }));
      return;
    }
    const restorable = new Set([
      'text/plain', 'text/html', 'text/rtf', 'image/png', NOTE_CLIP_FORMAT,
      // Browser copy operations attach these ordinary raw-format byte payloads.
      'electron application/osclipboard;format="Chromium internal source URL"',
      'electron application/osclipboard;format="Chromium internal source RFH token"',
    ]);
    if (types.some(type => !restorable.has(type))) {
      console.log('clipboard bridge smoke skipped: existing clipboard includes formats not verified for restoration');
      return;
    }
    // Materialize every payload before changing the OS clipboard: read() items
    // can otherwise refer back to clipboard data that the next write replaces.
    saved = await Promise.all(original.map(async item => {
      const entries = {};
      for (const type of item.types) {
        const blob = await item.getType(type);
        const bytes = Buffer.from(await blob.arrayBuffer());
        savedPayloads.set(type, bytes);
        entries[type] = new Blob([bytes], { type: blob.type });
      }
      return new ClipboardItem(entries);
    }));
    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const bridge = await loadClipboardBridge({ clipboard, ClipboardItem, nativeImage });
    const payload = JSON.stringify({ app: 'refboard', kind: 'note-clipboard', items: [{ text: 'Clipboard smoke 世界' }] });
    changed = true;
    assert.equal((await bridge.writeNotes({ payload, plainText: 'Clipboard smoke 世界' })).ok, true);
    assert.equal(await clipboard.readText(), 'Clipboard smoke 世界');
    assert.equal(await clipboard.has(NOTE_CLIP_FORMAT), true);
    assert.equal(await bridge.readNotes(), payload);
    assert.equal(await bridge.readImage(), null);

    const fixture = await fs.readFile(path.join(__dirname, '..', 'build', 'icon.png'));
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([fixture], { type: 'image/png' }) })]);
    assert.equal(await bridge.readNotes(), null);
    const encoded = await bridge.readImage();
    assert.ok(encoded, 'real image clipboard should return PNG data');
    const result = nativeImage.createFromBuffer(Buffer.from(encoded, 'base64'));
    const expected = nativeImage.createFromBuffer(fixture);
    assert.equal(result.isEmpty(), false);
    assert.deepEqual(result.getSize(), expected.getSize());
    assert.deepEqual(result.toBitmap(), expected.toBitmap(), 'existing fixture pixels must survive clipboard round-trip');
    console.log(`clipboard bridge smoke passed on Electron ${process.versions.electron}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    try {
      if (changed) {
        if (saved.length) await clipboard.write(saved);
        else clipboard.clear();
        const restored = await clipboard.read();
        for (const [type, bytes] of savedPayloads) {
          const item = restored.find(item => item.types.includes(type));
          assert.ok(item, 'original clipboard format must be restored');
          assert.deepEqual(Buffer.from(await (await item.getType(type)).arrayBuffer()), bytes,
            'original clipboard bytes must be restored');
        }
        if (!saved.length) assert.equal(restored.length, 0);
        console.log('Original clipboard restored');
      }
    } catch (error) {
      console.error('Could not restore original clipboard:', error);
      process.exitCode = 1;
    }
    win?.destroy();
    app.exit(process.exitCode || 0);
  }
});
