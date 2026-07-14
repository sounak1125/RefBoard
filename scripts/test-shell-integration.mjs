import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { isInstalledWindowsBuild } = require('./shell-integration');

const installedExe = path.resolve('C:/Users/test/AppData/Local/Programs/RefBoard/RefBoard.exe');
const installedUninstaller = path.join(path.dirname(installedExe), 'Uninstall RefBoard.exe');
const existsInstalledOnly = candidate => path.resolve(candidate).toLowerCase() === installedUninstaller.toLowerCase();

assert.equal(isInstalledWindowsBuild({
  platform: 'win32', isPackaged: true, exePath: installedExe, existsSync: existsInstalledOnly,
}), true, 'an NSIS installation may repair its own Explorer registration');

assert.equal(isInstalledWindowsBuild({
  platform: 'win32', isPackaged: true,
  exePath: path.resolve('C:/repo/.codex-package-check-4/win-unpacked/RefBoard.exe'),
  existsSync: () => false,
}), false, 'a disposable package-check build must never register shell DLLs');

assert.equal(isInstalledWindowsBuild({
  platform: 'win32', isPackaged: true,
  exePath: path.resolve('C:/repo/dist/win-unpacked/RefBoard.exe'),
  existsSync: () => false,
}), false, 'a run-without-installing build must not claim persistent shell integration');

assert.equal(isInstalledWindowsBuild({
  platform: 'win32', isPackaged: false, exePath: installedExe, existsSync: existsInstalledOnly,
}), false, 'development Electron must not register shell integration');

assert.equal(isInstalledWindowsBuild({
  platform: 'linux', isPackaged: true, exePath: installedExe, existsSync: existsInstalledOnly,
}), false, 'non-Windows builds must not attempt Explorer integration');

const main = await readFile(new URL('../main.js', import.meta.url), 'utf8');
assert.match(main, /isInstalledWindowsBuild\(\{/, 'main should guard runtime shell registration');
assert.match(main, /registerFileTypeIntegration\(\);/, 'installed builds should retain a self-repair path');

console.log('shell integration tests passed');
