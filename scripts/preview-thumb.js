'use strict';

const fs = require('fs');
const path = require('path');
const {
  extractPreviewBase64,
  compositeThumbnail,
  compositeFallbackThumbnail,
} = require('./file-icon-composite');

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('Usage: node scripts/preview-thumb.js <file.refboard> [output.png] [size]');
    process.exit(1);
  }

  const filePath = path.resolve(input);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const outArg = process.argv[3] && /\.png$/i.test(process.argv[3]) ? process.argv[3] : null;
  const sizeArg = process.argv[outArg ? 4 : 3];
  const size = sizeArg && !/\.png$/i.test(sizeArg) ? Number(sizeArg) : 256;
  const output = outArg || path.join(
    path.dirname(filePath),
    `${path.basename(filePath, path.extname(filePath))}-thumb.png`
  );

  const previewB64 = extractPreviewBase64(filePath);
  let png;
  if (previewB64) {
    const previewBuf = Buffer.from(previewB64, 'base64');
    png = await compositeThumbnail(previewBuf, size);
    console.log('Rendered content thumbnail from embedded preview.');
  } else {
    png = await compositeFallbackThumbnail(size);
    console.log('No preview field found — rendered fallback placeholder.');
  }

  fs.writeFileSync(output, png);
  console.log(`Wrote ${output}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
