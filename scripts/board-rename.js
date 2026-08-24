'use strict';

/**
 * Renaming a board is renaming its file.
 *
 * A .refboard file carries no title of its own — every title shown in RefBoard
 * is derived from the file name (see boardTitleFromPath in index.html). So the
 * landing-page rename has to move the file on disk, and the name it accepts has
 * to be a name the file system will actually take.
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const BOARD_EXT = '.refboard';
const MAX_BOARD_NAME_LENGTH = 120;
// Windows rejects these outright. Applying the same rule everywhere means a
// board renamed on one machine still opens on another.
const INVALID_NAME_CHARS = /[<>:"/\\|?*]/;
const RESERVED_DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const RENAME_REASON_TEXT = {
  'invalid-path': 'That board is not a .refboard file',
  empty: 'Enter a board name',
  'too-long': `Keep the name under ${MAX_BOARD_NAME_LENGTH} characters`,
  'invalid-chars': 'A board name cannot contain \\ / : * ? " < > |',
  'trailing-dot-or-space': 'A board name cannot end with a dot or a space',
  reserved: 'That name is reserved by Windows',
  exists: 'A board with that name is already in this folder',
  missing: 'That board file is no longer on disk',
  busy: 'That board is busy right now — try again in a moment',
};

function boardNameFromPath(filePath) {
  const base = path.basename(String(filePath || ''));
  return base.replace(/\.refboard$/i, '') || base;
}

function normalizeBoardName(raw) {
  // Users habitually type the extension back in. Accept it rather than
  // producing "Board.refboard.refboard".
  return String(raw ?? '').trim().replace(/\.refboard$/i, '').trim();
}

function hasControlCharacter(name) {
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validateBoardName(raw) {
  const name = normalizeBoardName(raw);
  if (!name) return { ok: false, name, reason: 'empty' };
  if (name.length > MAX_BOARD_NAME_LENGTH) return { ok: false, name, reason: 'too-long' };
  if (INVALID_NAME_CHARS.test(name) || hasControlCharacter(name)) return { ok: false, name, reason: 'invalid-chars' };
  if (/[. ]$/.test(name)) return { ok: false, name, reason: 'trailing-dot-or-space' };
  if (RESERVED_DEVICE_NAMES.test(name)) return { ok: false, name, reason: 'reserved' };
  return { ok: true, name, reason: null };
}

function boardRenameTargetPath(currentPath, name) {
  const dir = path.dirname(path.resolve(String(currentPath || '')));
  return path.join(dir, `${name}${BOARD_EXT}`);
}

function boardRenameFailureText(reason) {
  return RENAME_REASON_TEXT[reason] || 'Could not rename that board';
}

function sameResolvedPath(a, b) {
  return path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();
}

async function renameBoardFile(currentPath, rawName) {
  const from = path.resolve(String(currentPath || ''));
  if (!from || !/\.refboard$/i.test(from)) return { ok: false, reason: 'invalid-path' };

  const check = validateBoardName(rawName);
  if (!check.ok) return { ok: false, reason: check.reason };

  const to = boardRenameTargetPath(from, check.name);
  if (path.basename(from) === path.basename(to)) {
    return { ok: true, unchanged: true, from, to: from, name: check.name };
  }
  // A case-only rename ("board" -> "Board") targets the same file, so the
  // existence check below would reject the very rename being asked for.
  if (!sameResolvedPath(from, to) && fsSync.existsSync(to)) {
    return { ok: false, reason: 'exists', from, to };
  }
  if (!fsSync.existsSync(from)) return { ok: false, reason: 'missing', from, to };

  await fs.rename(from, to);
  // The .bak sidecar is this board's recovery copy. Leaving it behind would
  // both orphan it and strip the renamed board of its backup.
  const fromBak = `${from}.bak`;
  if (fsSync.existsSync(fromBak)) await fs.rename(fromBak, `${to}.bak`).catch(() => {});
  return { ok: true, unchanged: false, from, to, name: check.name };
}

module.exports = {
  BOARD_EXT,
  MAX_BOARD_NAME_LENGTH,
  boardNameFromPath,
  boardRenameFailureText,
  boardRenameTargetPath,
  normalizeBoardName,
  renameBoardFile,
  sameResolvedPath,
  validateBoardName,
};
