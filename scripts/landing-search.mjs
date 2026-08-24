/**
 * Filtering for the Home (landing) list of boards.
 *
 * A user with dozens of saved boards had no way to find one except scrolling.
 * Matching is AND-across-tokens so "trip 2024" narrows instead of widening, and
 * it searches the folder path as well as the title so two boards that share a
 * name are still separable by where they live.
 */

export function normalizeBoardQuery(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function boardQueryTokens(raw) {
  const normalized = normalizeBoardQuery(raw);
  return normalized ? normalized.split(' ') : [];
}

export function boardSearchHaystack(entry) {
  const title = String(entry?.title || '');
  const filePath = String(entry?.path || '');
  // Backslashes and forward slashes both become spaces so a query can name a
  // folder ("client work") without the user typing a separator.
  const pathWords = filePath.replace(/[\\/]/g, ' ');
  return `${title} ${filePath} ${pathWords}`.toLowerCase();
}

export function matchesBoardQuery(entry, tokens) {
  if (!tokens.length) return true;
  const haystack = boardSearchHaystack(entry);
  return tokens.every(token => haystack.includes(token));
}

export function filterRecentWorks(list, raw) {
  const tokens = boardQueryTokens(raw);
  if (!tokens.length) return Array.isArray(list) ? [...list] : [];
  return (Array.isArray(list) ? list : []).filter(entry => matchesBoardQuery(entry, tokens));
}

/**
 * Splits `text` into runs so the caller can wrap the matched runs. Returns a
 * single un-hit run when nothing matches, so rendering never has to branch.
 */
export function highlightSegments(text, raw) {
  const source = String(text ?? '');
  const tokens = boardQueryTokens(raw);
  if (!source || !tokens.length) return [{ text: source, hit: false }];

  const lower = source.toLowerCase();
  const hits = new Array(source.length).fill(false);
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(token, from);
      if (at === -1) break;
      for (let i = at; i < at + token.length; i++) hits[i] = true;
      from = at + token.length;
    }
  }

  const segments = [];
  let start = 0;
  for (let i = 1; i <= source.length; i++) {
    if (i < source.length && hits[i] === hits[start]) continue;
    segments.push({ text: source.slice(start, i), hit: hits[start] });
    start = i;
  }
  return segments;
}
