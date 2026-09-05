'use strict';

// Capture the actual RefBoard renderer with public fixtures in a disposable profile.
// No preload or main.js: this process cannot read the installed app's recent works,
// clipboard, board files, or thumbnails. See assets/readme/README.md for credits.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'assets', 'readme');
const cache = path.join(root, 'stress-out-smoke', 'readme', 'samples');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'refboard-readme-'));
const ids = [1015, 1016, 1018, 1039, 1043, 106];
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(cache, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const errors = [];

async function run(expression) {
  return win.webContents.executeJavaScript(expression);
}
async function waitFor(expression, label) {
  for (let i = 0; i < 200; i++) {
    if (await run(`Boolean(${expression})`).catch(() => false)) return;
    await delay(40);
  }
  throw new Error('Timed out waiting for ' + label);
}
async function capture(name) {
  await run('document.fonts.ready');
  await delay(1200);
  const shot = await win.webContents.capturePage();
  assert.equal(shot.isEmpty(), false, 'screenshot must have pixels');
  // Lossless PNG compression only; no retouching, compositing or invented UI.
  await sharp(shot.toPNG()).png({ compressionLevel: 9 }).toFile(path.join(output, name + '.png'));
  console.log('Captured ' + name + '.png');
}

async function main() {
  try {
    const fixtures = await Promise.all(ids.map(async id => {
      const file = path.join(cache, id + '.jpg');
      if (!fs.existsSync(file)) {
        const response = await fetch(`https://picsum.photos/id/${id}/1200/800`, {
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`Sample ${id}: HTTP ${response.status}`);
        fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      }
      return { id, data: fs.readFileSync(file).toString('base64') };
    }));
    await app.whenReady();
    win = new BrowserWindow({
      show: false, width: 1600, height: 1000, frame: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', details => {
      if (/Uncaught|SyntaxError|ReferenceError|TypeError/.test(details.message || '')) errors.push(details.message);
    });
    await win.loadFile(path.join(root, 'index.html'));
    await waitFor('window.RefBoard?.startupComplete', 'startup');
    await run(`localStorage.setItem('refboard.settings', JSON.stringify({
      landingLayout: 'classic', toolbarMode: 'pinned', tagLabels: 'selected'
    }));`);
    await win.loadFile(path.join(root, 'index.html'));
    await waitFor('window.RefBoard?.startupComplete', 'configured startup');
    assert.equal(await run('localStorage.getItem("refboard.recentWorks")'), null, 'profile must start without history');
    await run(`document.querySelector('#rwNewBoard').click()`);
    await waitFor(`document.body.classList.contains('board-active')`, 'new board');
    await delay(400);

    const scene = await run(`(async () => {
      const api = window.RefBoard;
      const samples = ${JSON.stringify(fixtures)};
      const images = await api.addImages(samples.map(sample => {
        const bytes = Uint8Array.from(atob(sample.data), c => c.charCodeAt(0));
        return new File([bytes], 'sample-landscape-' + sample.id + '.jpg', { type: 'image/jpeg' });
      }));
      const positions = [
        [596, 100, 354, 236], [0, 502, 274, 183],
        [0, 100, 570, 380], [596, 358, 354, 236],
        [296, 502, 274, 183], [976, 458, 284, 189]
      ];
      images.forEach((item, i) => {
        const [x, y, w, h] = positions[i];
        Object.assign(item, { x, y, w, h, tags: ['landscape', i === 5 ? 'texture' : 'outdoors'] });
      });
      const note = props => {
        const item = api.makeNoteForTest({ color: '#151820', textColor: '#eef2f6', opacity: 0.2,
          fontFamily: 'Segoe UI', fontSize: 17, x: 0, y: 0, ...props });
        api.state.items.push(item);
        return item;
      };
      note({ text: 'FIELD NOTES', x: 0, y: -52, w: 400, h: 35, fontSize: 15, textColor: '#90b4c9', bold: true });
      note({ text: 'Into the quiet', x: 0, y: -10, w: 650, h: 94, fontSize: 39, bold: true });
      note({ text: 'LANDSCAPE STUDY / 01', x: 976, y: 100, w: 300, h: 35,
        fontSize: 14, bold: true, textColor: '#90b4c9' });
      note({ text: 'Open spaces. Soft light.', x: 976, y: 145,
        w: 310, h: 45, fontSize: 21 });
      note({ text: 'A little room to breathe.', x: 976, y: 195,
        w: 310, h: 45, fontSize: 21 });
      note({ text: 'Look for\\n• Layered mountain silhouettes\\n• Muted greens and cool stone\\n• Water as a leading line',
        x: 976, y: 248, w: 320, h: 140, fontSize: 16, textColor: '#bac3ce' });
      note({ text: 'BOTANICAL DETAILS', x: 976, y: 407, w: 300, h: 30,
        fontSize: 13, bold: true, textColor: '#90b4c9' });
      note({ text: 'Natural tones', x: 596, y: 611, w: 340, h: 32, fontSize: 14, textColor: '#bac3ce' });
      ['#253b36', '#667c64', '#a7b5b6', '#e4ded1'].forEach((color, i) => {
        note({ text: color.toUpperCase(), color, opacity: 1, textColor: i < 2 ? '#ffffff' : '#192126',
          x: 596 + i * 91, y: 652, w: 81, h: 45, fontSize: 10 });
      });
      api.state.sel.clear();
      api.invalidateLayout();
      api.updateSelBarForTest();
      await api.fitAll();
      api.invalidate();
      return { images: images.length, notes: api.state.items.filter(i => i.kind === 'note').length };
    })()`);
    assert.equal(scene.images, ids.length);
    await waitFor(`window.RefBoard.images.size === ${ids.length}`, 'sample imports');
    await capture('board');

    // Home entries are fictional. Their thumbnails use only the downloaded samples.
    win.destroy();
    win = new BrowserWindow({
      show: false, width: 1600, height: 1000, frame: false,
      webPreferences: { partition: 'readme-library', contextIsolation: true,
        nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    win.webContents.on('console-message', details => {
      if (/Uncaught|SyntaxError|ReferenceError|TypeError/.test(details.message || '')) errors.push(details.message);
    });
    await win.loadFile(path.join(root, 'index.html'));
    await waitFor('window.RefBoard?.startupComplete', 'fresh library startup');
    await run(`(async () => {
      const samples = ${JSON.stringify(fixtures)};
      const titles = ['Into the quiet', 'Stone & sky', 'Highland light', 'Forest studies', 'Open spaces', 'Botanical details'];
      localStorage.setItem('refboard.recentWorks', JSON.stringify(samples.map((sample, i) => ({
        path: 'C:/Sample Boards/' + titles[i] + '.refboard', title: titles[i],
        itemCount: [18, 12, 9, 16, 8, 11][i],
        thumbnailData: sample.data, lastEdited: Date.now() - i * 86400000,
        pinned: i < 2, pinnedAt: i < 2 ? Date.now() - i * 1000 : null
      }))));
      await window.RefBoard.renderRecentWorksForTest();
    })()`);
    await waitFor(`document.querySelectorAll('#recentGrid .rw-card').length === 6`, 'sample library');
    await waitFor(`[...document.querySelectorAll('#recentGrid .rw-thumb img')].every(i => i.complete && i.naturalWidth > 0)`, 'library previews');
    await capture('library');
    await run(`document.querySelector('#rwLayoutFlow').click()`);
    await waitFor(`document.querySelectorAll('.ff-card').length === 6`, 'Focus Flow');
    await capture('focus-flow');
    assert.deepEqual(errors, [], 'renderer should have no errors');
    console.log(JSON.stringify({ profile: 'disposable', source: 'public Picsum samples only', ...scene, screenshots: 3 }));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    // Only delete the exact mkdtemp profile under the system temporary directory.
    const resolved = path.resolve(profile);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('refboard-readme-'));
    const { removeProfileDir } = await import('./smoke-profile-cleanup.mjs');
    await removeProfileDir(resolved);
    app.exit(process.exitCode || 0);
  }
}
void main();
