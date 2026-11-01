/**
 * What the What's New window and the Home card show for a payload from
 * main.js's buildWhatsNewPayload. It touches no DOM, so the choices it makes
 * (what leads, what folds away, what a release of fixes alone looks like) are
 * tested in Node by test-whats-new-view.mjs.
 */

// New features shown as tiles under the lead; any more fold away with the rest.
export const WHATS_NEW_TILES = 4;
// Changes the Home card names before it switches to a count.
export const WHATS_NEW_CARD_LINES = 3;

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

function entries(payload, key) {
  const items = Array.isArray(payload?.sections?.[key]) ? payload.sections[key] : [];
  return items.map(item => ({ key, item }));
}

function has(list, key) {
  return list.some(entry => entry.key === key);
}

function foldedTitle(rest) {
  if (has(rest, 'new')) return 'More changes';
  if (has(rest, 'improved') && has(rest, 'fixed')) return 'Improvements and fixes';
  return has(rest, 'improved') ? 'Improvements' : 'Fixes';
}

function unnamedCount(rest) {
  if (!rest.length) return '';
  if (has(rest, 'new')) return `+ ${rest.length} more`;
  if (has(rest, 'improved') && has(rest, 'fixed')) return `+ ${rest.length} improvements and fixes`;
  return `+ ${has(rest, 'improved') ? plural(rest.length, 'improvement', 'improvements') : plural(rest.length, 'fix', 'fixes')}`;
}

export function planWhatsNew(payload) {
  const news = entries(payload, 'new');
  const improved = entries(payload, 'improved');
  const fixed = entries(payload, 'fixed');
  const version = String(payload?.version || '');
  const fixesOnly = !news.length && !improved.length;

  // The window leads with the first new feature, else the first improvement.
  // The next few new features get tiles; everything else folds into one row.
  const lead = news[0] || improved[0] || null;
  const tiles = news.slice(1, 1 + WHATS_NEW_TILES);
  const rest = [...news.slice(1 + WHATS_NEW_TILES), ...improved.filter(entry => entry !== lead), ...fixed];

  // The Home card names the first few changes and counts the rest. A release
  // of fixes alone says it updated and what it fixed, with nothing to open.
  const line = ({ key, item }) => ({ key, title: item.title });
  let card;
  if (fixesOnly) {
    const lines = fixed.length > 1 ? fixed.slice(0, WHATS_NEW_CARD_LINES) : [];
    card = {
      kicker: `Updated to ${version}`,
      title: fixed.length === 1 ? fixed[0].item.title : plural(fixed.length, 'fix', 'fixes'),
      lines: lines.map(line),
      more: lines.length && fixed.length > lines.length ? `+ ${fixed.length - lines.length} more` : '',
      cta: false,
    };
  } else {
    const named = [...news, ...improved];
    const lines = named.slice(0, WHATS_NEW_CARD_LINES);
    card = {
      kicker: `What's new · ${version}`,
      title: String(payload?.headline || ''),
      lines: lines.map(line),
      more: unnamedCount([...named.slice(lines.length), ...fixed]),
      cta: true,
    };
  }

  return {
    fixesOnly,
    card,
    window: {
      kicker: `What's new in ${version}`,
      headline: String(payload?.headline || ''),
      summary: String(payload?.summary || ''),
      lead,
      tiles,
      rest,
      restTitle: rest.length ? foldedTitle(rest) : '',
      // With nothing to lead with, the fixes are the whole story, so they start open.
      restOpen: !lead,
      showVersions: Number(payload?.releaseCount) > 1,
      notesUrl: typeof payload?.notesUrl === 'string' ? payload.notesUrl : '',
    },
  };
}
