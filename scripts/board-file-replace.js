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

// Call only after a successful save. A backup is needed during replacement,
// not as a permanent sibling of the board. Failure to tidy an obsolete copy
// must not report the already-committed save as failed.
async function cleanupBoardBackup(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const target = path.resolve(filePath);
  if (await fileMtimeMs(target) == null) return false;
  try {
    await fs.unlink(boardBakPath(target));
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('Could not remove completed board backup:', err.message);
    return false;
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
    // The caller has flushed and closed the complete new file. Keep .bak if
    // the app stops before this point; remove it only after the swap succeeds.
    await cleanupBoardBackup(dest);
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
  cleanupBoardBackup,
  replaceBoardFile,
  recoverBoardFileIfMissing,
};
