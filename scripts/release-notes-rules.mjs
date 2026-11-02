/**
 * The release-notes format, shared by test-changelog-format.mjs and
 * sync-changelog.mjs so the two cannot disagree about it.
 *
 * What's New gets a few seconds of attention, so notes from SHORT_NOTES_SINCE
 * on are held to one-line limits. Text that does not fit goes in `details`,
 * which only the GitHub release shows. Older releases keep the notes they
 * shipped with.
 */
import newBadges from './new-badges.js';

export const SECTION_KEYS = ['new', 'improved', 'fixed'];

export const SHORT_NOTES_SINCE = '2.2.0';

// Characters per field, sized so each one fits a line of the What's New card.
export const LIMITS = {
  headline: 50,
  summary: 120,
  title: 40,
  description: 90,
  where: 40,
  note: 90,
};

// `where` says where to find the change and `note` carries a caveat (a
// download, a version requirement); the app shows both. `details` is the
// longer story and only goes to the GitHub release. `badge` names the control
// that gets a "New" badge (its data-badge in index.html); see new-badges.js.
export const OPTIONAL_ITEM_FIELDS = ['where', 'note', 'details', 'badge'];

const ITEM_FIELDS = ['title', 'description', ...OPTIONAL_ITEM_FIELDS];

function parseSemver(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

export function isShortNotesRelease(version) {
  const left = parseSemver(version);
  const right = parseSemver(SHORT_NOTES_SINCE);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return true;
}

/**
 * What is wrong with a release beyond its required fields: an unknown or empty
 * optional field or a malformed or repeated badge always, and with `short`
 * set, any text over its limit.
 */
export function releaseNoteProblems(release, { short = false } = {}) {
  const problems = [];
  const checkLength = (label, value, limit) => {
    if (!short || typeof value !== 'string') return;
    const length = value.trim().length;
    if (length > limit) problems.push(`${label} is ${length} characters; keep it to ${limit}`);
  };
  const badges = new Map();
  checkLength('headline', release?.headline, LIMITS.headline);
  checkLength('summary', release?.summary, LIMITS.summary);
  for (const key of SECTION_KEYS) {
    const items = Array.isArray(release?.sections?.[key]) ? release.sections[key] : [];
    items.forEach((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return;
      const at = `sections.${key}[${index}]`;
      for (const field of Object.keys(item)) {
        if (!ITEM_FIELDS.includes(field)) problems.push(`${at}.${field} is not a release-note field (${ITEM_FIELDS.join(', ')})`);
      }
      for (const field of OPTIONAL_ITEM_FIELDS) {
        if (field in item && (typeof item[field] !== 'string' || !item[field].trim())) {
          problems.push(`${at}.${field} must be text when present`);
        }
      }
      for (const field of ['title', 'description', 'where', 'note']) checkLength(`${at}.${field}`, item[field], LIMITS[field]);
      if (typeof item.badge === 'string' && item.badge.trim()) {
        if (!newBadges.BADGE_ID.test(item.badge)) {
          problems.push(`${at}.badge "${item.badge}" must be a lowercase id with dashes, like remove-object`);
        } else if (badges.has(item.badge)) {
          problems.push(`${at}.badge "${item.badge}" is already used by ${badges.get(item.badge)}; one control, one note`);
        } else {
          badges.set(item.badge, at);
        }
      }
    });
  }
  return problems;
}
