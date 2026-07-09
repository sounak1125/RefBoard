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

async function compositeBrandedThumbnail(thumbnailBuffer, size = 256) {
  const stripW = Math.max(1, Math.round(size * 0.80));
  const stripH = Math.max(1, Math.round(size * 0.38));
  const stripX = Math.round((size - stripW) / 2);
  const stripY = Math.round((size - stripH) / 2);
  const radius = Math.max(4, Math.round(size / 42));
  const badgeSize = Math.max(12, Math.round(size * 0.18));
  const margin = Math.max(3, Math.round(size / 24));
  const inset = Math.max(2, Math.round(badgeSize / 6));

  const board = await sharp(thumbnailBuffer)
    .resize(stripW, stripH, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();

  const roundedMask = Buffer.from(
    `<svg width="${stripW}" height="${stripH}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${stripW}" height="${stripH}" rx="${radius}" ry="${radius}" fill="white"/>
    </svg>`
  );

  const roundedBoard = await sharp(board)
    .composite([{
      input: await sharp(roundedMask).resize(stripW, stripH).png().toBuffer(),
      blend: 'dest-in',
    }])
    .png()
    .toBuffer();

  const vignette = Buffer.from(
    `<svg width="${stripW}" height="${stripH}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="v" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="rgba(0,0,0,0.24)"/>
          <stop offset="50%" stop-color="rgba(0,0,0,0)"/>
          <stop offset="100%" stop-color="rgba(0,0,0,0.24)"/>
        </linearGradient>
      </defs>
      <rect width="${stripW}" height="${stripH}" rx="${radius}" fill="url(#v)"/>
    </svg>`
  );

  const boardWithVignette = await sharp(roundedBoard)
    .composite([{ input: vignette, blend: 'over' }])
    .png()
    .toBuffer();

  const border = Buffer.from(
    `<svg width="${stripW}" height="${stripH}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0.5" y="0.5" width="${stripW - 1}" height="${stripH - 1}" rx="${radius}" ry="${radius}"
        fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
    </svg>`
  );

  const badgePlate = Buffer.from(
    `<svg width="${badgeSize}" height="${badgeSize}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${badgeSize / 2}" cy="${badgeSize / 2}" r="${badgeSize / 2 - 1}"
        fill="rgba(18,20,28,0.86)" stroke="rgba(90,200,255,0.47)" stroke-width="1"/>
    </svg>`
  );

  const brandSized = await sharp(loadBrandPng())
    .resize(badgeSize - inset * 2, badgeSize - inset * 2, { fit: 'inside' })
    .png()
    .toBuffer();

  const bgGradient = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0e0f14"/>
          <stop offset="100%" stop-color="#181a22"/>
        </linearGradient>
      </defs>
      <rect width="${size}" height="${size}" fill="url(#g)"/>
    </svg>`
  );

  const bg = await sharp(bgGradient).resize(size, size).png().toBuffer();

  const shadow = Buffer.from(
    `<svg width="${stripW + 4}" height="${stripH + 4}" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="3" width="${stripW}" height="${stripH}" rx="${radius}" fill="rgba(0,0,0,0.27)"/>
    </svg>`
  );

  const badgeX = size - badgeSize - margin;
  const badgeY = size - badgeSize - margin;

  return sharp(bg)
    .composite([
      { input: shadow, left: stripX - 1, top: stripY },
      { input: boardWithVignette, left: stripX, top: stripY },
      { input: border, left: stripX, top: stripY },
      { input: badgePlate, left: badgeX, top: badgeY },
      { input: brandSized, left: badgeX + inset, top: badgeY + inset },
    ])
    .png()
    .toBuffer();
}

async function compositeFallbackBrand(size = 256) {
  const badge = Math.round(size * 0.28);
  const brandSized = await sharp(loadBrandPng())
    .resize(badge, badge, { fit: 'inside' })
    .png()
    .toBuffer();

  const label = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <text x="50%" y="${Math.round(size * 0.72)}" text-anchor="middle"
        font-family="Segoe UI, sans-serif" font-size="${Math.max(6, Math.round(size / 22))}"
        fill="rgba(180,190,210,0.31)">RefBoard</text>
    </svg>`
  );

  const bgGradient = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#0e0f14"/>
          <stop offset="100%" stop-color="#181a22"/>
        </linearGradient>
      </defs>
      <rect width="${size}" height="${size}" fill="url(#g)"/>
    </svg>`
  );

  const bg = await sharp(bgGradient).resize(size, size).png().toBuffer();

  return sharp(bg)
    .composite([
      { input: brandSized, left: Math.round((size - badge) / 2), top: Math.round((size - badge) / 2 - size / 16) },
      { input: label, left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
}

module.exports = {
  extractPreviewBase64,
  compositeBrandedThumbnail,
  compositeFallbackBrand,
};
