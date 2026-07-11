'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const BRAND_PATH = path.join(ROOT, 'build', 'icon.png');

const PREVIEW_REGEX = /"preview"\s*:\s*"([A-Za-z0-9+/=]+)"/;

function loadBrandPng() {
  return fs.readFileSync(BRAND_PATH);
}

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
  const railWidth = Math.max(3, Math.round(size * 0.19));
  const gap = Math.max(2, Math.round(size * 0.055));
  const previewWidth = Math.max(4, size - padding * 2 - railWidth - gap);
  const previewHeight = Math.max(4, Math.round(previewWidth * 0.58));
  const brandSize = Math.max(3, Math.min(railWidth, Math.round(size * 0.17)));
  const previewX = padding;
  return {
    previewX,
    previewY: Math.round((size - previewHeight) / 2),
    previewWidth,
    previewHeight,
    radius: Math.max(1, Math.round(size / 28)),
    brandX: Math.round(size - padding - (railWidth + brandSize) / 2),
    brandY: Math.round((size - brandSize) / 2),
    brandSize,
    dividerX: previewX + previewWidth + Math.round(gap / 2),
  };
}

function thumbnailBackground(size, dividerX) {
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#111318"/>
          <stop offset="100%" stop-color="#181b22"/>
        </linearGradient>
      </defs>
      <rect width="${size}" height="${size}" fill="url(#g)"/>
      <line x1="${dividerX}" y1="${Math.round(size * 0.31)}" x2="${dividerX}" y2="${Math.round(size * 0.69)}"
        stroke="#529ef0" stroke-opacity="0.2" stroke-width="${Math.max(1, size / 256)}"/>
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

function previewBorder(layout) {
  return Buffer.from(
    `<svg width="${layout.previewWidth}" height="${layout.previewHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.5" y="0.5" width="${Math.max(1, layout.previewWidth - 1)}" height="${Math.max(1, layout.previewHeight - 1)}"
        rx="${layout.radius}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1"/>
    </svg>`
  );
}

async function sideBrand(size, layout) {
  return sharp(loadBrandPng())
    .resize(layout.brandSize, layout.brandSize, { fit: 'contain' })
    .png()
    .toBuffer();
}

async function compositeBrandedThumbnail(thumbnailBuffer, size = 256) {
  const layout = thumbnailLayout(size);
  const board = await sharp(thumbnailBuffer)
    .resize(layout.previewWidth, layout.previewHeight, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
  const roundedMask = Buffer.from(
    `<svg width="${layout.previewWidth}" height="${layout.previewHeight}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${layout.previewWidth}" height="${layout.previewHeight}" rx="${layout.radius}" fill="white"/>
    </svg>`
  );
  const roundedBoard = await sharp(board)
    .composite([{ input: roundedMask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  const brand = await sideBrand(size, layout);

  return sharp(thumbnailBackground(size, layout.dividerX))
    .composite([
      { input: previewShadow(layout), left: layout.previewX, top: layout.previewY },
      { input: roundedBoard, left: layout.previewX, top: layout.previewY },
      { input: previewBorder(layout), left: layout.previewX, top: layout.previewY },
      { input: brand, left: layout.brandX, top: layout.brandY },
    ])
    .png()
    .toBuffer();
}

async function compositeFallbackBrand(size = 256) {
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
  const brand = await sideBrand(size, layout);

  return sharp(thumbnailBackground(size, layout.dividerX))
    .composite([
      { input: previewShadow(layout), left: layout.previewX, top: layout.previewY },
      { input: placeholder, left: layout.previewX, top: layout.previewY },
      { input: brand, left: layout.brandX, top: layout.brandY },
    ])
    .png()
    .toBuffer();
}

module.exports = {
  extractPreviewBase64,
  compositeBrandedThumbnail,
  compositeFallbackBrand,
};
