'use strict';

const GWL_EXSTYLE = -20;
const GWLP_HWNDPARENT = -8;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const GW_HWNDNEXT = 2;
const GW_HWNDPREV = 3;
const GW_OWNER = 4;
const GW_CHILD = 5;
const HWND_TOP = 0n;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const DWMWA_CLOAKED = 14;
const SKIP_CLASSES = new Set([
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
  'Progman',
  'WorkerW',
  'NotifyIconOverflowWindow',
  'ForegroundStaging',
  'Xaml_WindowedPopupClass',
]);

let impl = null;

function load() {
  if (impl) return impl.ok ? impl : null;
  if (process.platform !== 'win32') {
    impl = { ok: false };
    return null;
  }
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const kernel32 = koffi.load('kernel32.dll');
    let DwmGetWindowAttribute = null;
    try {
      const dwmapi = koffi.load('dwmapi.dll');
      DwmGetWindowAttribute = dwmapi.func('long __stdcall DwmGetWindowAttribute(uintptr hwnd, uint attr, _Out_ uint *value, uint size)');
    } catch { /* DWM is optional. */ }

    impl = {
      ok: true,
      GetDesktopWindow: user32.func('uintptr __stdcall GetDesktopWindow()'),
      GetWindow: user32.func('uintptr __stdcall GetWindow(uintptr hwnd, uint cmd)'),
      GetWindowTextLengthW: user32.func('int __stdcall GetWindowTextLengthW(uintptr hwnd)'),
      GetWindowTextW: user32.func('int __stdcall GetWindowTextW(uintptr hwnd, _Out_ uint16 *text, int max)'),
      GetClassNameW: user32.func('int __stdcall GetClassNameW(uintptr hwnd, _Out_ uint16 *name, int max)'),
      IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(uintptr hwnd)'),
      IsWindow: user32.func('bool __stdcall IsWindow(uintptr hwnd)'),
      GetWindowLongPtrW: user32.func('intptr __stdcall GetWindowLongPtrW(uintptr hwnd, int index)'),
      SetWindowLongPtrW: user32.func('intptr __stdcall SetWindowLongPtrW(uintptr hwnd, int index, intptr value)'),
      SetWindowPos: user32.func('bool __stdcall SetWindowPos(uintptr hwnd, uintptr after, int x, int y, int cx, int cy, uint flags)'),
      SetLastError: kernel32.func('void __stdcall SetLastError(uint err)'),
      GetLastError: kernel32.func('uint __stdcall GetLastError()'),
      DwmGetWindowAttribute,
    };
    return impl;
  } catch (err) {
    console.warn('RefBoard pin helper unavailable:', err?.message || err);
    impl = { ok: false };
    return null;
  }
}

function toHwnd(id) {
  if (id == null || id === '') return 0n;
  try { return BigInt(id); } catch { return 0n; }
}

function hwndId(hwnd) {
  if (hwnd == null || hwnd === 0 || hwnd === 0n) return '';
  return typeof hwnd === 'bigint' ? hwnd.toString() : String(hwnd);
}

function readUtf16(fn, hwnd, max) {
  const buf = new Uint16Array(max);
  const n = fn(hwnd, buf, buf.length);
  if (n <= 0) return '';
  return String.fromCharCode(...buf.subarray(0, n));
}

function windowTitle(api, hwnd) {
  const len = Math.max(0, api.GetWindowTextLengthW(hwnd));
  if (len <= 0) return '';
  return readUtf16(api.GetWindowTextW, hwnd, Math.min(len + 1, 512)).trim();
}

function windowClass(api, hwnd) {
  return readUtf16(api.GetClassNameW, hwnd, 256);
}

function isCloaked(api, hwnd) {
  if (!api.DwmGetWindowAttribute) return false;
  const value = new Uint32Array(1);
  const hr = api.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, value, 4);
  return hr === 0 && value[0] !== 0;
}

function isCandidate(api, hwnd, skip) {
  if (!hwnd || hwnd === 0n || skip.has(hwndId(hwnd))) return false;
  if (!api.IsWindow(hwnd) || !api.IsWindowVisible(hwnd)) return false;
  if (isCloaked(api, hwnd)) return false;
  const title = windowTitle(api, hwnd);
  if (!title) return false;
  const cls = windowClass(api, hwnd);
  if (SKIP_CLASSES.has(cls)) return false;
  const ex = Number(api.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) >>> 0;
  const owner = api.GetWindow(hwnd, GW_OWNER);
  const hasOwner = !!(owner && owner !== 0 && owner !== 0n);
  if ((ex & WS_EX_TOOLWINDOW) && !(ex & WS_EX_APPWINDOW)) return false;
  if (hasOwner && !(ex & WS_EX_APPWINDOW)) return false;
  return true;
}

function listWindows(skipIds = []) {
  const api = load();
  if (!api) return [];
  const skip = new Set((skipIds || []).map(String).filter(Boolean));
  const found = [];
  const seen = new Set();
  let hwnd = api.GetWindow(api.GetDesktopWindow(), GW_CHILD);
  while (hwnd && hwnd !== 0 && hwnd !== 0n) {
    const id = hwndId(hwnd);
    if (id && !seen.has(id) && isCandidate(api, hwnd, skip)) {
      seen.add(id);
      found.push({ id, title: windowTitle(api, hwnd) });
      if (found.length >= 40) break;
    }
    hwnd = api.GetWindow(hwnd, GW_HWNDNEXT);
  }
  return found;
}

function windowInfo(id) {
  const api = load();
  const hwnd = toHwnd(id);
  if (!api || !hwnd || !api.IsWindow(hwnd)) return null;
  return { id: hwndId(hwnd), title: windowTitle(api, hwnd) || 'Window' };
}

function isWindow(id) {
  const api = load();
  const hwnd = toHwnd(id);
  return !!(api && hwnd && api.IsWindow(hwnd));
}

function attach(ourId, targetId) {
  const api = load();
  const our = toHwnd(ourId);
  const target = toHwnd(targetId);
  if (!api || !our || !target || !api.IsWindow(our) || !api.IsWindow(target)) return false;
  api.SetLastError(0);
  api.SetWindowLongPtrW(our, GWLP_HWNDPARENT, target);
  const err = api.GetLastError();
  const owner = api.GetWindowLongPtrW(our, GWLP_HWNDPARENT);
  const attached = hwndId(owner) === hwndId(target) && err === 0;
  api.SetWindowPos(our, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  return attached;
}

function detach(ourId) {
  const api = load();
  const our = toHwnd(ourId);
  if (!api || !our || !api.IsWindow(our)) return;
  api.SetWindowLongPtrW(our, GWLP_HWNDPARENT, 0n);
  api.SetWindowPos(our, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

function restack(ourId, targetId) {
  const api = load();
  const our = toHwnd(ourId);
  const target = toHwnd(targetId);
  if (!api || !our || !target || !api.IsWindow(our) || !api.IsWindow(target)) return;
  const prev = api.GetWindow(target, GW_HWNDPREV);
  const after = prev && prev !== 0 && prev !== 0n && hwndId(prev) !== hwndId(our) ? prev : HWND_TOP;
  api.SetWindowPos(our, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

module.exports = {
  listWindows,
  windowInfo,
  isWindow,
  attach,
  detach,
  restack,
};
