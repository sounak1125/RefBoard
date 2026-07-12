'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HANDLER_DIR = path.join(ROOT, 'build', 'thumbnail-handler');
const HANDLER_BIN = path.join(HANDLER_DIR, 'bin');
const HANDLER_DLL = path.join(HANDLER_BIN, 'RefBoardThumbnailHandler.dll');
const SHARP_DLL = path.join(HANDLER_BIN, 'SharpShell.dll');
const PACKAGES_DIR = path.join(HANDLER_DIR, 'packages');
const SHARP_PKG = path.join(PACKAGES_DIR, 'SharpShell.2.7.2', 'lib', 'net40-client', 'SharpShell.dll');
const CSC = process.env.windir
  ? path.join(process.env.windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  : null;

function ensureSharpShell() {
  if (fs.existsSync(SHARP_PKG)) {
    fs.mkdirSync(HANDLER_BIN, { recursive: true });
    fs.copyFileSync(SHARP_PKG, SHARP_DLL);
    return;
  }
  if (!fs.existsSync(SHARP_DLL)) {
    throw new Error('SharpShell.dll missing. Run: npm run build:thumb-handler (needs nuget packages)');
  }
}

function buildHandler() {
  if (process.platform !== 'win32') {
    console.log('Skipping thumbnail handler build (Windows only)');
    return;
  }
  if (!CSC || !fs.existsSync(CSC)) {
    throw new Error('csc.exe not found (.NET Framework required to build thumbnail handler)');
  }
  ensureSharpShell();
  fs.mkdirSync(HANDLER_BIN, { recursive: true });
  const args = [
    '/nologo', '/target:library', '/platform:x64',
    `/out:${HANDLER_DLL}`,
    `/reference:${SHARP_DLL}`,
    '/reference:System.Drawing.dll',
    path.join(HANDLER_DIR, 'RefBoardThumbnailHandler.cs'),
  ];
  execFileSync(CSC, args, { stdio: 'inherit' });
  console.log('Built', HANDLER_DLL);
}

buildHandler();
