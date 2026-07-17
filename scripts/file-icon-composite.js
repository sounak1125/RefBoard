'use strict';

const fs = require('fs');
const sharp = require('sharp');

const PREVIEW_REGEX = /"preview"\s*:\s*"([A-Za-z0-9+/=]+)"/;

function extractPreviewBase64(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const maxRead = 512 * 1024;
    const headBuf = Buffer.alloc(Math.min(maxRead, stat.size));
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    let match = PREVIEW_REGEX.exec(headBuf.toString('utf8'));
    if (match) return match[1];

    if (stat.size > maxRead) {
      const tailStart = stat.size - maxRead;
      const tailBuf = Buffer.alloc(maxRead);
      fs.readSync(fd, tailBuf, 0, maxRead, tailStart);
      match = PREVIEW_REGEX.exec(tailBuf.toString('utf8'));
      if (match) return match[1];
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function thumbnailLayout(size) {
  const padding = Math.max(1, Math.round(size * 0.06));
  const previewWidth = Math.max(4, size - padding * 2);
  const previewHeight = Math.max(4, Math.round(previewWidth * 0.58));
  const previewX = padding;
  return {
    previewX,
    previewY: Math.round((size - previewHeight) / 2),
    previewWidth,
    previewHeight,
    radius: Math.max(1, Math.round(size / 28)),
  };
}

function thumbnailBackground(size) {
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#111318"/>
          <stop offset="100%" stop-color="#181b22"/>
        </linearGradient>
      </defs>
      <rect width="${size}" height="${size}" fill="url(#g)"/>
    </svg>`
  );
}

function previewShadow(layout) {
  return Buffer.from(
    `<svg width="${layout.previewWidth + 2}" height="${layout.previewHeight + 3}" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="2" width="${layout.previewWidth}" height="${layout.previewHeight}"
        rx="${layout.radius}" fill="rgba(0,0,0,0.27)"/>
    </svg>`
  );
}

async function compositeThumbnail(thumbnailBuffer, size = 256) {
  // The Explorer type overlay owns the single lower-right RefBoard logo.
  // Mirror the handler by returning a square center crop, including for the
  // wide embedded previews stored by older RefBoard versions.
  return sharp(thumbnailBuffer)
    .resize(size, size, { fit: 'cover', position: 'centre', withoutEnlargement: false })
    .png()
    .toBuffer();
}

async function compositeFallbackThumbnail(size = 256) {
  const layout = thumbnailLayout(size);
  const innerPad = Math.max(1, Math.floor(layout.previewWidth / 14));
  const tileGap = Math.max(1, Math.floor(layout.previewWidth / 28));
  const tileWidth = Math.max(1, Math.floor((layout.previewWidth - innerPad * 2 - tileGap * 2) / 3));
  const innerHeight = Math.max(2, layout.previewHeight - innerPad * 2);
  const tileRadius = Math.max(1, Math.floor(layout.radius / 2));
  const tile2X = innerPad + tileWidth + tileGap;
  const tile3X = innerPad + (tileWidth + tileGap) * 2;
  const placeholder = Buffer.from(
    `<svg width="${layout.previewWidth}" height="${layout.previewHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${layout.previewWidth}" height="${layout.previewHeight}" rx="${layout.radius}" fill="#161920"/>
      <rect x="${innerPad}" y="${innerPad}" width="${tileWidth}" height="${Math.max(1, Math.round(innerHeight * 0.55))}" rx="${tileRadius}" fill="rgba(82,158,240,0.28)"/>
      <rect x="${tile2X}" y="${innerPad + Math.round(innerHeight * 0.18)}" width="${tileWidth}" height="${Math.max(1, Math.round(innerHeight * 0.82))}" rx="${tileRadius}" fill="rgba(217,163,106,0.25)"/>
      <rect x="${tile3X}" y="${innerPad}" width="${tileWidth}" height="${Math.max(1, Math.round(innerHeight * 0.65))}" rx="${tileRadius}" fill="rgba(122,136,168,0.23)"/>
      <rect x="0.5" y="0.5" width="${Math.max(1, layout.previewWidth - 1)}" height="${Math.max(1, layout.previewHeight - 1)}"
        rx="${layout.radius}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
    </svg>`
  );
  return sharp(thumbnailBackground(size))
    .composite([
      { input: previewShadow(layout), left: layout.previewX, top: layout.previewY },
      { input: placeholder, left: layout.previewX, top: layout.previewY },
    ])
    .png()
    .toBuffer();
}

module.exports = {
  extractPreviewBase64,
  compositeThumbnail,
  compositeFallbackThumbnail,
};
