'use strict';

// Copies the canonical reel (build/installer-ui) into bootstrapper/ui before
// building, so you never maintain two copies. Run automatically by npm start / dist.

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'build', 'installer-ui');
const dest = path.join(__dirname, 'ui');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(src)) {
  console.error('[sync-ui] Cannot find build/installer-ui at', src);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
copyDir(src, dest);
console.log('[sync-ui] Copied installer-ui ->', path.relative(process.cwd(), dest));
