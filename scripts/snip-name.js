'use strict';

/**
 * File name for a snip: "Snip – <window in front> – 14.03.png", or
 * "Snip – 14.03.png" when there is no usable title (none, or RefBoard's own).
 * The name lands on the board item and, from there, on exported and dragged-out
 * files, so it is kept legal as a Windows file name.
 */

const TITLE_MAX = 80;
// Reserved in Windows file names, plus control characters.
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;

function snipTime(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getHours())}.${pad(date.getMinutes())}`;
}

function cleanSnipTitle(title, max = TITLE_MAX) {
  let text = String(title || '').replace(ILLEGAL, ' ').replace(/\s+/g, ' ').trim();
  // Cut by code point, so a long title never ends in half an emoji.
  const chars = [...text];
  if (chars.length > max) text = `${chars.slice(0, max - 1).join('').trimEnd()}…`;
  // Windows drops trailing dots and spaces from a name; do it up front.
  return text.replace(/[. ]+$/, '');
}

function snipFileName(title, date = new Date()) {
  const clean = cleanSnipTitle(title);
  const time = snipTime(date);
  return clean ? `Snip – ${clean} – ${time}.png` : `Snip – ${time}.png`;
}

module.exports = { TITLE_MAX, snipTime, cleanSnipTitle, snipFileName };
