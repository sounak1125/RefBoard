'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const MASTER_PATH = path.join(BUILD, 'icon-master.png');
const PNG_PATH = path.join(BUILD, 'icon.png');
const ICO_PATH = path.join(BUILD, 'icon.ico');
const INSTALLER_HEADER_PATH = path.join(BUILD, 'installerHeader.bmp');
const INSTALLER_SIDEBAR_PATH = path.join(BUILD, 'installerSidebar.bmp');
const THUMBNAIL_BRAND_PATH = path.join(BUILD, 'thumbnail-handler', 'brand.png');
const PNG_SIZE = 256;
const ICO_SIZES = [16, 32, 48, 64, 128, 256];
const INSTALLER_BG = '#131419';

async function resizePng(input, size) {
  return sharp(input)
    .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function writeIco(pngBuffers) {
  const toIco = (await import('to-ico')).default;
  const ico = await toIco(pngBuffers);
  fs.writeFileSync(ICO_PATH, ico);
}

function installerSidebarSvg() {
  return Buffer.from(`
    <svg width="164" height="314" viewBox="0 0 164 314" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#1c1f26"/>
          <stop offset="0.58" stop-color="#131419"/>
          <stop offset="1" stop-color="#0f1014"/>
        </linearGradient>
        <radialGradient id="glow" cx="50%" cy="0" r="80%">
          <stop offset="0" stop-color="#529ef0" stop-opacity="0.22"/>
          <stop offset="1" stop-color="#529ef0" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="164" height="314" fill="url(#bg)"/>
      <rect width="164" height="190" fill="url(#glow)"/>
      <g fill="#66abf5" opacity="0.13">
        <circle cx="16" cy="18" r="1"/><circle cx="32" cy="18" r="1"/><circle cx="48" cy="18" r="1"/>
        <circle cx="116" cy="18" r="1"/><circle cx="132" cy="18" r="1"/><circle cx="148" cy="18" r="1"/>
        <circle cx="16" cy="34" r="1"/><circle cx="148" cy="34" r="1"/>
      </g>
      <text x="82" y="146" text-anchor="middle" fill="#eef2f8" font-family="Segoe UI, Arial, sans-serif" font-size="20" font-weight="600">RefBoard</text>
      <text x="82" y="164" text-anchor="middle" fill="#9299a6" font-family="Segoe UI, Arial, sans-serif" font-size="8.5" letter-spacing="0.25">moodboard + reference</text>
      <line x1="34" y1="235" x2="130" y2="235" stroke="#66abf5" stroke-opacity="0.18"/>
      <text x="82" y="273" text-anchor="middle" fill="#737b88" font-family="Segoe UI, Arial, sans-serif" font-size="8.5" letter-spacing="0.3">made by</text>
      <text x="82" y="289" text-anchor="middle" fill="#66abf5" font-family="Segoe UI, Arial, sans-serif" font-size="11" font-weight="600">Sounak</text>
    </svg>`);
}

function installerHeaderSvg() {
  return Buffer.from(`
    <svg width="150" height="57" viewBox="0 0 150 57" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stop-color="#1b1e24"/>
          <stop offset="1" stop-color="#111217"/>
        </linearGradient>
        <radialGradient id="glow" cx="12%" cy="50%" r="70%">
          <stop offset="0" stop-color="#529ef0" stop-opacity="0.18"/>
          <stop offset="1" stop-color="#529ef0" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="150" height="57" fill="url(#bg)"/>
      <rect width="150" height="57" fill="url(#glow)"/>
      <text x="55" y="25" fill="#eef2f8" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="600">RefBoard</text>
      <text x="55" y="40" fill="#8e96a3" font-family="Segoe UI, Arial, sans-serif" font-size="7.4" letter-spacing="0.22">moodboard + reference</text>
      <rect y="55" width="150" height="2" fill="#529ef0" fill-opacity="0.42"/>
    </svg>`);
}

async function writeBmp(png, width, height, outputPath) {
  const { data, info } = await sharp(png)
    .flatten({ background: INSTALLER_BG })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.width !== width || info.height !== height || info.channels !== 3) {
    throw new Error(`Unexpected bitmap input for ${outputPath}: ${info.width}x${info.height}, ${info.channels} channels`);
  }

  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowStride * height;
  const bmp = Buffer.alloc(54 + pixelBytes);
  bmp.write('BM', 0, 2, 'ascii');
  bmp.writeUInt32LE(bmp.length, 2);
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(width, 18);
  bmp.writeInt32LE(height, 22);
  bmp.writeUInt16LE(1, 26);
  bmp.writeUInt16LE(24, 28);
  bmp.writeUInt32LE(pixelBytes, 34);
  bmp.writeInt32LE(2835, 38);
  bmp.writeInt32LE(2835, 42);

  for (let y = 0; y < height; y += 1) {
    const sourceRow = (height - 1 - y) * width * 3;
    const outputRow = 54 + y * rowStride;
    for (let x = 0; x < width; x += 1) {
      const source = sourceRow + x * 3;
      const output = outputRow + x * 3;
      bmp[output] = data[source + 2];
      bmp[output + 1] = data[source + 1];
      bmp[output + 2] = data[source];
    }
  }

  fs.writeFileSync(outputPath, bmp);
}

async function writeInstallerArtwork(masterPng) {
  const sidebarIcon = await resizePng(masterPng, 94);
  const sidebar = await sharp(installerSidebarSvg())
    .composite([{ input: sidebarIcon, left: 35, top: 25 }])
    .png()
    .toBuffer();
  await writeBmp(sidebar, 164, 314, INSTALLER_SIDEBAR_PATH);

  const headerIcon = await resizePng(masterPng, 42);
  const header = await sharp(installerHeaderSvg())
    .composite([{ input: headerIcon, left: 7, top: 7 }])
    .png()
    .toBuffer();
  await writeBmp(header, 150, 57, INSTALLER_HEADER_PATH);

  console.log('Wrote', INSTALLER_HEADER_PATH, '(150x57, 24-bit BMP)');
  console.log('Wrote', INSTALLER_SIDEBAR_PATH, '(164x314, 24-bit BMP)');
}

function replaceRequired(html, pattern, replacement, label) {
  if (!pattern.test(html)) {
    throw new Error(`Could not find ${label} in index.html`);
  }
  return html.replace(pattern, replacement);
}

async function main() {
  const meta = await sharp(MASTER_PATH).metadata();
  if (meta.format !== 'png' || meta.hasAlpha !== true || meta.width !== meta.height || meta.width < 512) {
    throw new Error('icon-master.png must be a square RGBA PNG at least 512px wide');
  }

  const masterPng = fs.readFileSync(MASTER_PATH);
  const runtimePng = await resizePng(masterPng, PNG_SIZE);
  fs.writeFileSync(PNG_PATH, runtimePng);
  fs.mkdirSync(path.dirname(THUMBNAIL_BRAND_PATH), { recursive: true });
  fs.writeFileSync(THUMBNAIL_BRAND_PATH, runtimePng);
  console.log('Wrote', PNG_PATH, `(${PNG_SIZE}x${PNG_SIZE}, transparent)`);
  console.log('Wrote', THUMBNAIL_BRAND_PATH, `(${PNG_SIZE}x${PNG_SIZE}, transparent)`);

  const icoPngs = await Promise.all(ICO_SIZES.map((size) => resizePng(masterPng, size)));
  await writeIco(icoPngs);
  console.log('Wrote', ICO_PATH, `(${ICO_SIZES.join(', ')} px)`);

  await writeInstallerArtwork(masterPng);

  const titlebarB64 = (await resizePng(masterPng, 32)).toString('base64');
  const landingB64 = runtimePng.toString('base64');
  const htmlPath = path.join(ROOT, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = replaceRequired(
    html,
    /(<link rel="icon" type="image\/png" href="data:image\/png;base64,)[A-Za-z0-9+/=]+(")/,
    `$1${titlebarB64}$2`,
    'favicon data URL'
  );
  html = replaceRequired(
    html,
    /(<img id="titlebarIcon"[^>]+src="data:image\/png;base64,)[A-Za-z0-9+/=]+(")/,
    `$1${titlebarB64}$2`,
    'titlebar icon data URL'
  );
  html = replaceRequired(
    html,
    /(<img id="landingBrandIcon"[^>]+src="data:image\/png;base64,)[A-Za-z0-9+/=]+(")/,
    `$1${landingB64}$2`,
    'landing icon data URL'
  );
  fs.writeFileSync(htmlPath, html);
  console.log('Updated favicon + titlebar + landing icons in index.html');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
