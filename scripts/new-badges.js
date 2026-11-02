'use strict';

/*
 * "New" badges. After an update, the controls a release added carry a small
 * "New" mark until the person clicks Got it or uses the control, so a new
 * feature gets noticed even when What's New was skipped.
 *
 * A release note points at its control with `badge`, an id the control carries
 * as data-badge in index.html, and the badge's one line is that note's
 * description: one sentence serves What's New, the badge and GitHub. This file
 * decides which badges a launch shows; main.js keeps them in whats-new.json as
 * `badges`, next to `lastRunVersion`.
 */

const BADGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SECTION_KEYS = ['new', 'improved', 'fixed'];

function parseVersion(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function normalizeBadge(item) {
  if (!item || typeof item !== 'object') return null;
  const id = typeof item.badge === 'string' ? item.badge.trim() : '';
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  if (!BADGE_ID.test(id) || !title) return null;
  const description = typeof item.description === 'string' ? item.description.trim() : '';
  return { id, title, description };
}

/** Badges from the releases after `from` up to and including `to`. When two
    notes point at the same control, the newer one's words win. */
function badgesBetween(changelog, from, to) {
  const low = parseVersion(from);
  const high = parseVersion(to);
  if (!low || !high || !changelog || typeof changelog !== 'object') return [];
  const releases = Object.keys(changelog)
    .map(version => ({ version, parsed: parseVersion(version) }))
    .filter(({ parsed }) => parsed && compareVersions(parsed, low) > 0 && compareVersions(parsed, high) <= 0)
    .sort((a, b) => compareVersions(b.parsed, a.parsed));
  const badges = [];
  const ids = new Set();
  for (const { version } of releases) {
    const sections = changelog[version]?.sections;
    if (!sections || typeof sections !== 'object') continue;
    for (const key of SECTION_KEYS) {
      for (const item of Array.isArray(sections[key]) ? sections[key] : []) {
        const badge = normalizeBadge(item);
        if (!badge || ids.has(badge.id)) continue;
        ids.add(badge.id);
        badges.push(badge);
      }
    }
  }
  return badges;
}

/** The badges still waiting in a store, with anything malformed dropped. */
function pendingBadges(store) {
  const list = Array.isArray(store?.badges) ? store.badges : [];
  const ids = new Set();
  const badges = [];
  for (const entry of list) {
    const badge = normalizeBadge({ ...entry, badge: entry?.id });
    if (!badge || ids.has(badge.id)) continue;
    ids.add(badge.id);
    badges.push(badge);
  }
  return badges;
}

/**
 * The store after launching `current`, or null when it does not change.
 *
 * The first launch of a version takes the badges of every release since the
 * version that ran before. A store from before badges has no lastRunVersion,
 * so the last version whose What's New was seen stands in; a first install has
 * neither and gets no badges, since everything is new to it. An update with no
 * badges of its own keeps the ones still waiting, unless it starts a new minor
 * version: by then they are not new any more.
 */
function storeAfterLaunch(store, changelog, current) {
  const state = store && typeof store === 'object' && !Array.isArray(store) ? store : {};
  const now = parseVersion(current);
  if (!now || state.lastRunVersion === current) return null;
  const from = state.lastRunVersion || state.lastSeenVersion || current;
  const fresh = badgesBetween(changelog, from, current);
  const before = parseVersion(from);
  const sameMinor = !!before && before[0] === now[0] && before[1] === now[1];
  return {
    ...state,
    lastRunVersion: current,
    badges: fresh.length ? fresh : sameMinor ? pendingBadges(state) : [],
  };
}

/** The store once a badge has been seen, or null when it was not waiting. */
function withoutBadge(store, id) {
  const badges = pendingBadges(store);
  if (!badges.some(badge => badge.id === id)) return null;
  return { ...store, badges: badges.filter(badge => badge.id !== id) };
}

module.exports = { BADGE_ID, badgesBetween, pendingBadges, storeAfterLaunch, withoutBadge };
