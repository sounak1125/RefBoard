'use strict';
// Read-only: pulls a spread of images out of the user's recent .refboard files
// into a scratch pool. Opens every board with flag 'r' and never writes to it.
//   node extract-pool.js <outDir> [perBoard]
const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const { readContainerIndex, readContainerImage, isContainerHead } =
  require(path.join(__dirname, '..', 'board-container.js'));

const outDir = process.argv[2];
const perBoard = Number(process.argv[3] || 6);
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

(async () => {
  const recent = JSON.parse(fss.readFileSync(
    path.join(process.env.APPDATA, 'RefBoard', 'recent-works.json'), 'utf8'));
  await fs.mkdir(outDir, { recursive: true });
  const manifest = [];
  const seenPaths = new Set();
  for (const board of recent) {
    const p = board.path;
    if (!p || seenPaths.has(p) || !fss.existsSync(p)) continue;
    seenPaths.add(p);
    let handle;
    try {
      handle = await fs.open(p, 'r');
      const size = (await handle.stat()).size;
      const head = Buffer.alloc(8);
      await handle.read(head, 0, 8, 0);
      if (!isContainerHead(head)) { console.log(`skip (not container): ${board.title}`); continue; }
      const found = await readContainerIndex(handle, size);
      const imgs = (found?.index?.images || []).filter(im =>
        EXT[im.type] && Math.min(im.w, im.h) >= 640);
      console.log(`${board.title}: ${found?.index?.images?.length || 0} images, ${imgs.length} usable`);
      if (!imgs.length) continue;
      const step = imgs.length / Math.min(perBoard, imgs.length);
      for (let k = 0; k < Math.min(perBoard, imgs.length); k++) {
        const im = imgs[Math.floor(k * step)];
        const bytes = await readContainerImage(handle, im, size);
        const slug = board.title.replace(/[^a-z0-9]+/gi, '-').slice(0, 24);
        const file = `${String(manifest.length).padStart(3, '0')}-${slug}.${EXT[im.type]}`;
        await fs.writeFile(path.join(outDir, file), bytes);
        manifest.push({ file, board: board.title, boardPath: p, imageId: im.id, w: im.w, h: im.h, type: im.type });
      }
    } catch (err) {
      console.log(`skip (${err.message}): ${board.title}`);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`pool: ${manifest.length} images`);
})();
