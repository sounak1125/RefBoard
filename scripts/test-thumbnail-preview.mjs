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
    create: { width: 640, height: 267, channels: 3, background: '#24324a' },
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
  assert.equal(meta.height, 267);

  const providerOutput = await compositeThumbnail(decoded, 256);
  const outputMeta = await sharp(providerOutput).metadata();
  assert.equal(outputMeta.format, 'png', 'thumbnail-provider mirror should produce a valid bitmap');
  assert.ok(outputMeta.width <= 256 && outputMeta.height <= 256, 'provider output should respect Explorer size');

  const handlerSource = await readFile(new URL('../build/thumbnail-handler/RefBoardThumbnailHandler.cs', import.meta.url), 'utf8');
  assert.match(handlerSource, /MaxReadBytes\s*=\s*512\s*\*\s*1024/, 'native handler should scan enough header data');
  assert.match(handlerSource, /PreviewRegex\s*=\s*new Regex/, 'native handler should extract the embedded preview field');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

console.log('thumbnail preview tests passed');
