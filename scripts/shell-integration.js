'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Explorer integration is installer-owned. A packaged app may repair it only
 * when it is running from an actual NSIS installation (identified by the
 * colocated uninstaller). This prevents disposable win-unpacked/package-check
 * builds from registering DLL paths that disappear after testing.
 */
function isInstalledWindowsBuild({
  platform = process.platform,
  isPackaged = false,
  exePath = process.execPath,
  productName = 'RefBoard',
  existsSync = fs.existsSync,
} = {}) {
  if (platform !== 'win32' || !isPackaged || !exePath) return false;
  if (path.basename(exePath).toLowerCase() === 'electron.exe') return false;
  const installDir = path.dirname(path.resolve(exePath));
  const uninstaller = path.join(installDir, `Uninstall ${productName}.exe`);
  return !!existsSync(uninstaller);
}

module.exports = { isInstalledWindowsBuild };
