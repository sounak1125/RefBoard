import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const { boardHeaderPrefix } = require('./board-save-format');
const { extractPreviewBase64, compositeThumbnail } = require('./file-icon-composite');

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'refboard-thumb-test-'));
try {
  const previewBytes = await sharp({
    create: { width: 640, height: 640, channels: 3, background: '#24324a' },
  }).jpeg({ quality: 80 }).toBuffer();
  const preview = previewBytes.toString('base64');
  const filePath = path.join(tempDir, 'large-streamed.refboard');
  const header = boardHeaderPrefix({ app: 'refboard', version: 3, items: [] }, preview);
  const largeTail = Buffer.alloc(2 * 1024 * 1024, 0x41);
  await writeFile(filePath, Buffer.concat([Buffer.from(header), largeTail]));

  const extracted = extractPreviewBase64(filePath);
  assert.equal(extracted, preview, 'Explorer extraction should find a streamed board preview in the file header');
  const decoded = Buffer.from(extracted, 'base64');
  const meta = await sharp(decoded).metadata();
  assert.equal(meta.format, 'jpeg', 'embedded board preview should be a decodable JPEG');
  assert.equal(meta.width, 640);
  assert.equal(meta.height, 640);

  const providerOutput = await compositeThumbnail(decoded, 256);
  const outputMeta = await sharp(providerOutput).metadata();
  assert.equal(outputMeta.format, 'png', 'thumbnail-provider mirror should produce a valid bitmap');
  assert.equal(outputMeta.width, 256, 'thumbnail-provider output should match Explorer width');
  assert.equal(outputMeta.height, 256, 'thumbnail-provider output should match Explorer height');

  const legacyWidePreview = await sharp({
    create: { width: 640, height: 267, channels: 3, background: '#4a3224' },
  }).jpeg({ quality: 80 }).toBuffer();
  const legacyProviderOutput = await compositeThumbnail(legacyWidePreview, 256);
  const legacyOutputMeta = await sharp(legacyProviderOutput).metadata();
  assert.equal(legacyOutputMeta.width, 256, 'legacy wide previews should be cropped to Explorer width');
  assert.equal(legacyOutputMeta.height, 256, 'legacy wide previews should be cropped to Explorer height');

  const handlerSource = await readFile(new URL('../build/thumbnail-handler/RefBoardThumbnailHandler.cs', import.meta.url), 'utf8');
  assert.match(handlerSource, /MaxReadBytes\s*=\s*512\s*\*\s*1024/, 'native handler should scan enough header data');
  assert.match(handlerSource, /PreviewRegex\s*=\s*new Regex/, 'native handler should extract the embedded preview field');

  const rendererSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(
    rendererSource,
    /\.rw-thumb\s*\{[\s\S]*?background:\s*#1b1d24[\s\S]*?const THUMBNAIL_CANVAS_BACKGROUND\s*=\s*['"]#1b1d24['"]/i,
    'thumbnail rendering should use the same opaque backdrop as the landing thumbnail surface',
  );
  assert.match(
    rendererSource,
    /if \(background\)\s*\{[\s\S]*?g\.fillStyle\s*=\s*background;[\s\S]*?g\.fillRect\(0, 0, c\.width, c\.height\);[\s\S]*?\}\s*g\.translate/,
    'the backdrop must be painted before board transforms and item drawing',
  );
  assert.match(
    rendererSource,
    /captureBoardThumbnailBase64[\s\S]*?boundedCompositeCanvas\(state\.items,\s*\{[\s\S]*?background:\s*THUMBNAIL_CANVAS_BACKGROUND/,
    'landing-page thumbnails should never flatten transparent layout gaps to black',
  );
  assert.match(
    rendererSource,
    /captureBoardFilePreviewBase64[\s\S]*?boundedCompositeCanvas\(state\.items,\s*\{[\s\S]*?maxWidth:\s*maxPx,[\s\S]*?maxHeight:\s*maxPx,[\s\S]*?fit:\s*['"]cover['"][\s\S]*?background:\s*THUMBNAIL_CANVAS_BACKGROUND/,
    'saved board previews should use the same safe backdrop',
  );
  assert.match(
    handlerSource,
    /new Bitmap\(size, size, PixelFormat\.Format32bppArgb\)/,
    'native thumbnail handler should always return the square bitmap Explorer requested',
  );
  assert.match(
    rendererSource,
    /scheduleSavedRecentWork[\s\S]*?await trackRecentWork\(\{[\s\S]*?cacheThumbnail:\s*true[\s\S]*?if \(onLanding\) await renderRecentWorks\(\)/,
    'the landing grid should refresh when deferred thumbnail generation finishes',
  );
  const setThumbImage = rendererSource.match(
    /function setRwThumbImage\(thumbEl, src\)\s*\{([\s\S]*?)\n\}/,
  )?.[1] || '';
  assert.match(
    setThumbImage,
    /thumbEl\.querySelector\(['"]:scope > svg['"]\)\?\.remove\(\)/,
    'loading a thumbnail must remove the empty-state SVG instead of leaving a black flex child',
  );
  assert.ok(
    setThumbImage.indexOf("querySelector(':scope > svg')")
      < setThumbImage.indexOf("classList.remove('rw-thumb-empty')"),
    'the placeholder SVG should be removed before its empty-state styling is detached',
  );
  assert.match(
    rendererSource,
    /\.rw-thumb img\s*\{[^}]*min-width:\s*0;[^}]*flex:\s*1 1 100%;[^}]*object-fit:\s*cover/s,
    'loaded thumbnails should own the complete flex width for current and recent cards',
  );
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log('thumbnail preview tests passed');
