'use strict';

/**
 * Tells Explorer a .refboard file changed so it re-reads the icon/thumbnail.
 *
 * This used to spawn `powershell.exe` with an `Add-Type` block, which compiles
 * C# at runtime — seconds of CPU and tens of MB of RAM — and it ran on *every*
 * board save, silent autosaves included. Calling SHChangeNotify through koffi
 * (already a dependency, see win32-zorder.js) does the same job in well under a
 * millisecond with no process spawn and no antivirus heuristic to trip.
 */

// shellapi.h
const SHCNE_UPDATEITEM = 0x00002000;
const SHCNE_ASSOCCHANGED = 0x08000000;
const SHCNF_PATHW = 0x00000005;
const SHCNF_FLUSHNOWAIT = 0x00002000;

let impl = null;

function load() {
  if (impl) return impl.ok ? impl : null;
  if (process.platform !== 'win32') {
    impl = { ok: false };
    return null;
  }
  try {
    const koffi = require('koffi');
    const shell32 = koffi.load('shell32.dll');
    impl = {
      ok: true,
      // The wide-string overloads take the path as a UTF-16 pointer; koffi
      // marshals a JS string to str16 for us.
      SHChangeNotifyPath: shell32.func('void __stdcall SHChangeNotify(long eventId, uint flags, str16 item1, void *item2)'),
      SHChangeNotifyBare: shell32.func('void __stdcall SHChangeNotify(long eventId, uint flags, void *item1, void *item2)'),
    };
    return impl;
  } catch (err) {
    console.warn('RefBoard shell notify unavailable:', err?.message || err);
    impl = { ok: false };
    return null;
  }
}

/**
 * @param {string|null} filePath Refresh just this file when given, otherwise
 *   tell the shell the file association changed.
 * @returns {boolean} whether the notification was delivered.
 */
function refreshShellIcons(filePath = null) {
  const api = load();
  if (!api) return false;
  try {
    if (filePath) {
      api.SHChangeNotifyPath(SHCNE_UPDATEITEM, SHCNF_PATHW | SHCNF_FLUSHNOWAIT, String(filePath), null);
    }
    api.SHChangeNotifyBare(SHCNE_ASSOCCHANGED, SHCNF_FLUSHNOWAIT, null, null);
    return true;
  } catch (err) {
    console.warn('RefBoard shell notify failed:', err?.message || err);
    return false;
  }
}

module.exports = { refreshShellIcons };
