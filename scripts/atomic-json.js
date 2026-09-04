'use strict';

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

/**
 * Write a JSON document so a crash mid-write cannot leave it truncated.
 *
 * recent-works.json and whats-new.json were written with a plain writeFile,
 * which truncates the file first. A crash or power loss between the truncate
 * and the last byte left invalid JSON; the loader caught the parse error and
 * returned an empty list, so the user's whole recents list and every pin
 * vanished with no message. Write to a sibling temp file, flush it, then
 * rename over the target: rename is atomic on the filesystems Windows uses,
 * so the target is either the old document or the new one, never half.
 */
async function writeJsonAtomic(filePath, value, { indent = 2 } = {}) {
  const target = path.resolve(String(filePath));
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const text = JSON.stringify(value, null, indent);
  let handle = null;
  try {
    handle = await fs.open(tempPath, 'wx');
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(tempPath, target);
  } catch (err) {
    try { await handle?.close(); } catch { /* already closed */ }
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
  return { path: target, bytes: Buffer.byteLength(text, 'utf8') };
}

module.exports = { writeJsonAtomic };
