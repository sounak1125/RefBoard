/**
 * The Snip shortcut: from a recorded key press to an Electron accelerator, and
 * from an accelerator to what the page shows. main.js validates every
 * accelerator the page sends with this, and the Settings page records and
 * displays with it, so the two can never disagree about what is allowed.
 *
 * Keys are read from KeyboardEvent.code, the physical key, so a recording does
 * not depend on the keyboard layout. Allowed: A-Z, 0-9 and F1-F24, with at
 * least two of Ctrl, Alt and Shift. One is not enough: a global shortcut takes
 * its keys from every app on the PC, and the one-modifier combinations are
 * the ones apps use (Ctrl+C, Ctrl+Z, Alt+F, Alt+F4, Ctrl+F5, Shift+F10...).
 * F13-F24 are the exception, with any modifiers or none: no app uses them by
 * default, and people map macro keys to them. The Windows key is never
 * offered; Windows keeps most Win combinations for itself.
 *
 * Loads as CommonJS and as a plain script (window.SnipShortcut).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnipShortcut = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  const DEFAULT_ACCELERATOR = 'Control+Alt+S';
  const MODIFIER_CODES = new Set([
    'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight',
    'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'AltGraph',
  ]);

  /** 'KeyS' -> 'S', 'Digit4' -> '4', 'F11' -> 'F11'; anything else -> null. */
  function keyFromCode(code) {
    const text = String(code || '');
    let m = /^Key([A-Z])$/.exec(text);
    if (m) return m[1];
    m = /^Digit([0-9])$/.exec(text);
    if (m) return m[1];
    m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(text);
    if (m) return `F${m[1]}`;
    return null;
  }

  function isFunctionKey(key) {
    return /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  }

  // F13-F24: on no keyboard by default, so free for macro keys.
  function isSpareFunctionKey(key) {
    return /^F(1[3-9]|2[0-4])$/.test(key);
  }

  function isAllowedKey(key) {
    return /^[A-Z0-9]$/.test(key) || isFunctionKey(key);
  }

  function modifierRule(mods, key) {
    if (isSpareFunctionKey(key)) return null;
    const count = (mods.ctrl ? 1 : 0) + (mods.alt ? 1 : 0) + (mods.shift ? 1 : 0);
    return count >= 2 ? null : 'needs-two-modifiers';
  }

  function format({ ctrl, alt, shift, key }) {
    return [ctrl && 'Control', alt && 'Alt', shift && 'Shift', key].filter(Boolean).join('+');
  }

  /**
   * Parse an accelerator into its parts, or null when it is not one this
   * feature accepts. Takes Electron's spellings (Control, Ctrl, Alt, Shift) in
   * any order and any case.
   */
  function parseAccelerator(accelerator) {
    if (typeof accelerator !== 'string' || accelerator.length > 40) return null;
    const parts = accelerator.split('+').map(p => p.trim());
    if (!parts.length || parts.some(p => !p)) return null;
    const mods = { ctrl: false, alt: false, shift: false };
    let key = null;
    for (const part of parts) {
      const lower = part.toLowerCase();
      const mod = lower === 'control' || lower === 'ctrl' ? 'ctrl'
        : lower === 'alt' ? 'alt'
          : lower === 'shift' ? 'shift' : null;
      if (mod) {
        if (mods[mod] || key) return null;
        mods[mod] = true;
        continue;
      }
      if (key) return null;
      const upper = part.toUpperCase();
      if (!isAllowedKey(upper)) return null;
      key = upper;
    }
    if (!key || modifierRule(mods, key)) return null;
    return { ...mods, key };
  }

  /** The canonical form ('Control+Alt+S'), or null for an invalid one. */
  function normalizeAccelerator(accelerator) {
    const parsed = parseAccelerator(accelerator);
    return parsed ? format(parsed) : null;
  }

  /**
   * A keydown during recording. Returns { accelerator } for a usable press,
   * { ignore: true } for a lone modifier (still being held down), or
   * { reason } for a press that cannot be a shortcut.
   */
  function acceleratorFromEvent(e) {
    const code = String(e?.code || '');
    if (MODIFIER_CODES.has(code)) return { ignore: true };
    if (e?.metaKey) return { reason: 'win' };
    const key = keyFromCode(code);
    if (!key) return { reason: 'unsupported-key' };
    const mods = { ctrl: !!e.ctrlKey, alt: !!e.altKey, shift: !!e.shiftKey };
    const reason = modifierRule(mods, key);
    if (reason) return { reason };
    return { accelerator: format({ ...mods, key }) };
  }

  const HINTS = {
    'needs-two-modifiers': 'Use two of Ctrl, Alt and Shift',
    'unsupported-key': 'Use a letter, a digit or F1–F24',
    win: 'The Windows key cannot be used',
  };
  function hintFor(reason) {
    return HINTS[reason] || '';
  }

  /** Key caps for display: 'Control+Alt+S' -> ['Ctrl', 'Alt', 'S']. */
  function acceleratorCaps(accelerator) {
    const parsed = parseAccelerator(accelerator);
    if (!parsed) return [];
    return [parsed.ctrl && 'Ctrl', parsed.alt && 'Alt', parsed.shift && 'Shift', parsed.key].filter(Boolean);
  }

  function acceleratorLabel(accelerator) {
    return acceleratorCaps(accelerator).join('+');
  }

  /* Windows reports AltGr as Ctrl+Alt, so a global Ctrl+Alt+<key> also takes
     AltGr+<key>, which types a letter on many layouts (ś on Polish). */
  function blocksAltGr(accelerator) {
    const parsed = parseAccelerator(accelerator);
    return !!(parsed && parsed.ctrl && parsed.alt);
  }

  /** The stored setting, with anything missing or invalid back at its default. */
  function normalizeSnipShortcut(value) {
    const enabled = value && typeof value.enabled === 'boolean' ? value.enabled : true;
    const accelerator = normalizeAccelerator(value?.accelerator) || DEFAULT_ACCELERATOR;
    return { enabled, accelerator };
  }

  return {
    DEFAULT_ACCELERATOR,
    keyFromCode,
    parseAccelerator,
    normalizeAccelerator,
    acceleratorFromEvent,
    hintFor,
    acceleratorCaps,
    acceleratorLabel,
    blocksAltGr,
    normalizeSnipShortcut,
  };
}));
