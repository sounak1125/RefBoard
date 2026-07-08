'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const BRAND_PATH = path.join(ROOT, 'build', 'icon.png');

async function loadBrandPng() {
  return fs.readFileSync(BRAND_PATH);
}

async function compositeBrandedThumbnail(thumbnailBuffer, size = 256) {
  const pad = Math.max(2, Math.round(size / 32));
  const inner = size - pad * 2;
  const badgeSize = Math.max(12, Math.round(size * 0.26));
  const margin = Math.max(2, Math.round(size / 28));
  const brand = await sharp(await loadBrandPng())
    .resize(badgeSize - Math.max(4, Math.round(badgeSize / 7)), null, { fit: 'inside' })
    .png()
    .toBuffer();

  const thumbMeta = await sharp(thumbnailBuffer).metadata();
  const scale = Math.min(inner / (thumbMeta.width || 1), inner / (thumbMeta.height || 1));
  const w = Math.max(1, Math.round((thumbMeta.width || 1) * scale));
  const h = Math.max(1, Math.round((thumbMeta.height || 1) * scale));
  const x = pad + Math.round((inner - w) / 2);
  const y = pad + Math.round((inner - h) / 2);

  const board = await sharp(thumbnailBuffer)
    .resize(w, h, { fit: 'inside' })
    .png()
    .toBuffer();

  const radius = Math.max(4, Math.round(size / 16));
  const roundedBoard = await sharp({
    create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: board, left: 0, top: 0 }])
    .png()
    .toBuffer();

  const badgePlate = Buffer.from(
    `<svg width="${badgeSize}" height="${badgeSize}" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="${badgeSize - 2}" height="${badgeSize - 2}" rx="${Math.round(badgeSize / 4)}"
        fill="rgba(18,20,28,0.92)" stroke="rgba(90,200,255,0.7)" stroke-width="1.2"/>
    </svg>`
  );

  const inset = Math.max(2, Math.round(badgeSize / 7));
  const brandSized = await sharp(brand).resize(badgeSize - inset * 2, badgeSize - inset * 2, { fit: 'inside' }).png().toBuffer();

  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 20, g: 20, b: 24, alpha: 255 } },
  })
    .composite([
      { input: roundedBoard, left: x, top: y },
      { input: badgePlate, left: size - badgeSize - margin, top: size - badgeSize - margin },
      {
        input: brandSized,
        left: size - badgeSize - margin + inset,
        top: size - badgeSize - margin + inset,
      },
    ])
    .png()
    .toBuffer();
}

module.exports = { compositeBrandedThumbnail };
