'use strict';

/**
 * What the recents list keeps, and what it lets go.
 *
 * Recents are a history: opening a board puts it at the front and the tail
 * falls off the end. That is right for a history and wrong for the two or
 * three boards someone actually lives in — they scroll off after a busy week
 * and there is nothing the person can do about it.
 *
 * A pinned board is exempt. Pins are kept *in addition* to the recent slots
 * rather than competing for them, so pinning something never costs you a
 * slot in your history, and unpinning never silently drops anything either.
 */

const MAX_RECENT = 24;
const MAX_PINNED = 12;

function isPinned(entry) {
  return !!(entry && entry.pinned);
}

/**
 * Split a recents list into what to keep and what to discard.
 *
 * Original order is preserved: the store stays a history, and the landing page
 * is what sorts pins to the front. Entries past the pin limit are demoted
 * rather than dropped, so they still compete for an ordinary recent slot —
 * losing a pin should never also lose the board.
 *
 * Returns dropped entries too, because the caller owns their thumbnails.
 */
function capRecentWorks(list, maxRecent = MAX_RECENT, maxPinned = MAX_PINNED) {
  const kept = [];
  const dropped = [];
  let pins = 0;
  let loose = 0;
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry) continue;
    if (isPinned(entry) && pins < maxPinned) {
      pins++;
      kept.push(entry);
      continue;
    }
    if (loose < maxRecent) {
      loose++;
      kept.push(isPinned(entry) ? { ...entry, pinned: false } : entry);
      continue;
    }
    dropped.push(entry);
  }
  return { kept, dropped };
}

/** Display order: pins first, each group still newest-first. */
function sortRecentWorks(list) {
  const entries = (Array.isArray(list) ? list : []).filter(Boolean);
  const pinned = entries.filter(isPinned);
  const rest = entries.filter(entry => !isPinned(entry));
  return [...pinned, ...rest];
}

/** How many more boards can be pinned before the limit bites. */
function pinsRemaining(list, maxPinned = MAX_PINNED) {
  const used = (Array.isArray(list) ? list : []).filter(isPinned).length;
  return Math.max(0, maxPinned - used);
}

module.exports = {
  MAX_PINNED,
  MAX_RECENT,
  capRecentWorks,
  isPinned,
  pinsRemaining,
  sortRecentWorks,
};
