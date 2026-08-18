'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

function boardBakPath(target) {
  return `${target}.bak`;
}

function isLegacyBackupName(base, name) {
  return typeof name === 'string' && name.startsWith(`${base}.backup-`);
}

async function fileMtimeMs(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

async function replaceBoardFile(target, tempPath) {
  const dest = path.resolve(String(target || ''));
  const temp = path.resolve(String(tempPath || ''));
  if (!dest || !temp || dest === temp) throw new Error('Invalid board replace paths');
  const bakPath = boardBakPath(dest);
  let movedToBak = false;
  try {
    if (fsSync.existsSync(dest)) {
      if (fsSync.existsSync(bakPath)) await fs.unlink(bakPath);
      await fs.rename(dest, bakPath);
      movedToBak = true;
    }
    await fs.rename(temp, dest);
    return { replaced: true, bakPath: fsSync.existsSync(bakPath) ? bakPath : null };
  } catch (err) {
    if (movedToBak && !fsSync.existsSync(dest)) {
      await fs.rename(bakPath, dest).catch(() => {});
    }
    await fs.unlink(temp).catch(() => {});
    throw err;
  }
}

async function newestLegacyBackupPath(target) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  let names = [];
  try { names = await fs.readdir(dir); } catch { return null; }
  const backups = [];
  for (const name of names) {
    if (!isLegacyBackupName(base, name)) continue;
    const full = path.join(dir, name);
    const mtime = await fileMtimeMs(full);
    if (mtime == null) continue;
    backups.push({ full, mtime });
  }
  backups.sort((a, b) => b.mtime - a.mtime);
  return backups[0]?.full || null;
}

async function recoverBoardFileIfMissing(filePath) {
  if (!filePath || typeof filePath !== 'string') return { exists: false, recovered: false };
  const target = path.resolve(filePath);
  if (fsSync.existsSync(target)) return { exists: true, recovered: false };

  const bakPath = boardBakPath(target);
  let candidate = null;
  if (await fileMtimeMs(bakPath) != null) candidate = bakPath;
  if (!candidate) candidate = await newestLegacyBackupPath(target);
  if (!candidate) return { exists: false, recovered: false };

  try {
    await fs.rename(candidate, target);
  } catch {
    return { exists: fsSync.existsSync(target), recovered: false };
  }
  const exists = fsSync.existsSync(target);
  return { exists, recovered: exists };
}

module.exports = {
  boardBakPath,
  replaceBoardFile,
  recoverBoardFileIfMissing,
};
