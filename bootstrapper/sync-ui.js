'use strict';

// Copies the canonical reel (build/installer-ui) into bootstrapper/ui before
// building, so you never maintain two copies. Run automatically by npm start / dist.
// Also stamps the Version line from the root RefBoard package.json so the
// cinematic UI cannot drift behind the release version.

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'build', 'installer-ui');
const dest = path.join(__dirname, 'ui');
const rootPkgPath = path.join(__dirname, '..', 'package.json');
const bootPkgPath = path.join(__dirname, 'package.json');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function stampInstallVersion(uiDir) {
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
  const bootPkg = JSON.parse(fs.readFileSync(bootPkgPath, 'utf8'));
  const version = String(rootPkg.version || bootPkg.version || '').trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.warn('[sync-ui] skipping version stamp; no semver found');
    return;
  }
  if (bootPkg.version !== version) {
    console.warn(`[sync-ui] bootstrapper package.json is ${bootPkg.version}, root is ${version}`);
  }
  const indexPath = path.join(uiDir, 'index.html');
  if (!fs.existsSync(indexPath)) return;
  const before = fs.readFileSync(indexPath, 'utf8');
  const versionRe = /Version\s+(\d+\.\d+\.\d+)/;
  const match = before.match(versionRe);
  if (!match) {
    console.warn('[sync-ui] install meta version string not found to stamp');
    return;
  }
  if (match[1] === version) {
    console.log(`[sync-ui] Installer UI already at version ${version}`);
    return;
  }
  const after = before.replace(versionRe, `Version ${version}`);
  fs.writeFileSync(indexPath, after, 'utf8');
  console.log(`[sync-ui] Stamped installer UI version ${match[1]} -> ${version}`);
}

if (!fs.existsSync(src)) {
  console.error('[sync-ui] Cannot find build/installer-ui at', src);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
copyDir(src, dest);
stampInstallVersion(dest);
console.log('[sync-ui] Copied installer-ui ->', path.relative(process.cwd(), dest));
