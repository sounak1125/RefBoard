#!/usr/bin/env node
/**
 * What the What's New window and the Home card choose to show, on real
 * releases from changelog.json: a feature release, a release of fixes alone,
 * one of improvements alone, and seven skipped updates at once. Every change
 * must still be reachable: nothing dropped, nothing shown twice.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WHATS_NEW_CARD_LINES, WHATS_NEW_TILES, planWhatsNew } from './whats-new-view.mjs';

const changelog = JSON.parse(readFileSync(new URL('../changelog.json', import.meta.url), 'utf8'));
const KEYS = ['new', 'improved', 'fixed'];

// The payload main.js builds: one release, or several merged newest first.
function payloadFor(versions) {
  const sections = { new: [], improved: [], fixed: [] };
  for (const version of versions) {
    for (const key of KEYS) for (const item of changelog[version].sections[key]) sections[key].push({ ...item, version });
  }
  const latest = changelog[versions[0]];
  return {
    show: true,
    version: versions[0],
    headline: versions.length > 1 ? `Everything new since ${versions.at(-1)}` : latest.headline,
    summary: latest.summary,
    sections,
    releaseCount: versions.length,
    notesUrl: 'https://github.com/sounak1125/RefBoard/releases',
  };
}

const titles = list => list.map(({ item }) => item.title);
const total = payload => KEYS.reduce((sum, key) => sum + payload.sections[key].length, 0);

// The window's invariant: lead, tiles and the folded rows hold every change once.
function assertEveryChangeOnce(payload, plan, label) {
  const shown = [plan.window.lead, ...plan.window.tiles, ...plan.window.rest].filter(Boolean).map(({ key, item }) => `${key}:${item.version}:${item.title}`);
  const all = KEYS.flatMap(key => payload.sections[key].map(item => `${key}:${item.version}:${item.title}`));
  assert.deepEqual([...shown].sort(), [...all].sort(), `${label}: the window shows every change exactly once`);
  const named = plan.card.lines.length;
  const counted = Number(/\+ (\d+)/.exec(plan.card.more)?.[1] || 0);
  const titleCounts = plan.fixesOnly && !named ? 1 : 0;
  assert.equal(named + counted + titleCounts, total(payload), `${label}: the Home card names or counts every change`);
}

// A feature release: 2.2.0.
{
  const payload = payloadFor(['2.2.0']);
  const plan = planWhatsNew(payload);
  assert.equal(plan.fixesOnly, false);
  assert.equal(plan.window.lead.item.title, 'Remove object', 'the first new feature leads');
  assert.deepEqual(titles(plan.window.tiles), ['Align rows left, center or right', 'Label alignment'], 'the other new features get tiles');
  assert.deepEqual(plan.window.rest.map(({ key, item }) => [key, item.title]), [['improved', 'Security update'], ['fixed', 'RefBoard reopens after an update']], 'improvements and fixes fold away');
  assert.equal(plan.window.restTitle, 'Improvements and fixes');
  assert.equal(plan.window.restOpen, false, 'folded until asked for');
  assert.equal(plan.window.showVersions, false, 'one release needs no version tags');
  assert.equal(plan.window.kicker, "What's new in 2.2.0");
  assert.equal(plan.card.kicker, "What's new · 2.2.0");
  assert.equal(plan.card.title, 'Remove objects from images', 'the card leads with the headline');
  assert.deepEqual(plan.card.lines.map(line => line.title), ['Remove object', 'Align rows left, center or right', 'Label alignment']);
  assert.equal(plan.card.more, '+ 2 improvements and fixes');
  assert.equal(plan.card.cta, true);
  assertEveryChangeOnce(payload, plan, '2.2.0');
}

// A release of fixes alone: 2.1.6.
{
  const payload = payloadFor(['2.1.6']);
  const plan = planWhatsNew(payload);
  assert.equal(plan.fixesOnly, true);
  assert.equal(plan.card.kicker, 'Updated to 2.1.6');
  assert.equal(plan.card.title, 'Board no longer jumps while panning', 'one fix is named in the title');
  assert.deepEqual(plan.card.lines, []);
  assert.equal(plan.card.more, '');
  assert.equal(plan.card.cta, false, 'nothing to open for a fix');
  assert.equal(plan.window.lead, null);
  assert.equal(plan.window.restTitle, 'Fixes');
  assert.equal(plan.window.restOpen, true, 'with nothing to lead with, the fixes start open');
  assertEveryChangeOnce(payload, plan, '2.1.6');
}

// Several fixes alone: the card names three and counts the rest.
{
  const payload = payloadFor(['2.1.6']);
  payload.sections.fixed = ['One', 'Two', 'Three', 'Four', 'Five'].map(title => ({ title, description: 'Works now.', version: '2.1.6' }));
  const plan = planWhatsNew(payload);
  assert.equal(plan.card.title, '5 fixes');
  assert.deepEqual(plan.card.lines.map(line => line.title), ['One', 'Two', 'Three']);
  assert.equal(plan.card.more, '+ 2 more');
  assertEveryChangeOnce(payload, plan, 'five fixes');
}

// Improvements alone: 2.1.2 leads with its first improvement.
{
  const payload = payloadFor(['2.1.2']);
  const plan = planWhatsNew(payload);
  assert.equal(plan.fixesOnly, false);
  assert.equal(plan.window.lead.key, 'improved');
  assert.equal(plan.window.lead.item.title, 'Boards are one file');
  assert.deepEqual(plan.window.tiles, []);
  assert.deepEqual(titles(plan.window.rest), ['Saves stay quick']);
  assert.equal(plan.window.restTitle, 'Improvements');
  assert.equal(plan.card.more, '', 'both improvements are named on the card');
  assertEveryChangeOnce(payload, plan, '2.1.2');
}

// Seven skipped updates: the newest feature leads, four more get tiles, and
// the other 32 changes fold into one row instead of 37 cards.
{
  const payload = payloadFor(['2.2.0', '2.1.6', '2.1.5', '2.1.4', '2.1.3', '2.1.2', '2.1.1']);
  const plan = planWhatsNew(payload);
  assert.equal(plan.window.lead.item.title, 'Remove object');
  assert.equal(plan.window.tiles.length, WHATS_NEW_TILES);
  assert.equal(plan.window.rest.length, 32);
  assert.equal(plan.window.restTitle, 'More changes');
  assert.equal(plan.window.showVersions, true, 'several releases tag each change with its version');
  assert.equal(plan.card.lines.length, WHATS_NEW_CARD_LINES);
  assert.equal(plan.card.more, '+ 34 more');
  assertEveryChangeOnce(payload, plan, 'seven skipped updates');
}

console.log("whats new view ok - feature, fixes-only, improvements-only and skipped-update releases each show every change once");
