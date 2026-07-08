'use strict';

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const SVG_PATH = path.join(BUILD, 'icon.svg');
const PNG_PATH = path.join(BUILD, 'icon.png');
const ICO_PATH = path.join(BUILD, 'icon.ico');
const PNG_SIZE = 256;
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

function renderSvgPng(svg, size) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: 'rgba(0,0,0,0)',
  });
  return resvg.render().asPng();
}

async function writeIco(pngBuffers) {
  const toIco = (await import('to-ico')).default;
  const ico = await toIco(pngBuffers);
  fs.writeFileSync(ICO_PATH, ico);
}

async function main() {
  const svg = fs.readFileSync(SVG_PATH);

  const masterPng = renderSvgPng(svg, PNG_SIZE);
  fs.writeFileSync(PNG_PATH, masterPng);
  console.log('Wrote', PNG_PATH, `(${PNG_SIZE}x${PNG_SIZE}, transparent)`);

  const icoPngs = await Promise.all(
    ICO_SIZES.map((size) => sharp(masterPng).resize(size, size).png().toBuffer())
  );
  await writeIco(icoPngs);
  console.log('Wrote', ICO_PATH, `(${ICO_SIZES.join(', ')} px)`);

  const meta = await sharp(masterPng).metadata();
  if (meta.hasAlpha !== true) {
    throw new Error('icon.png is missing alpha channel (expected transparent background)');
  }

  const titlebarB64 = (await sharp(masterPng).resize(32, 32).png().toBuffer()).toString('base64');
  const htmlPath = path.join(ROOT, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  html = html.replace(
    /(<link rel="icon" type="image\/png" href="data:image\/png;base64,)[A-Za-z0-9+/=]+(")/,
    `$1${titlebarB64}$2`
  );
  html = html.replace(
    /(<img id="titlebarIcon"[^>]+src="data:image\/png;base64,)[A-Za-z0-9+/=]+(")/,
    `$1${titlebarB64}$2`
  );
  fs.writeFileSync(htmlPath, html);
  console.log('Updated favicon + titlebar fallback in index.html');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
