#!/usr/bin/env node
/**
 * Before dist: if package.json has a new version, copy its structured release
 * notes from release-highlights.json and merge any tagged git highlights.
 *
 * Commit examples:
 *   [highlight:new] Feature title | What it lets people do.
 *   [highlight:improved] Improvement title | What now feels better.
 *   [highlight:fixed] Bug title | What now works correctly.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECTION_KEYS = ['new', 'improved', 'fixed'];

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseSemver(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

function semverGt(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] > right[i]) return true;
    if (left[i] < right[i]) return false;
  }
  return false;
}

function git(command) {
  try {
    return execSync(command, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function emptySections() {
  return { new: [], improved: [], fixed: [] };
}

function normalizeItem(value) {
  if (typeof value === 'string') {
    const title = value.trim();
    return title ? { title, description: '' } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const title = String(value.title || '').trim();
  const description = String(value.description || '').trim();
  if (!title && !description) return null;
  return { title: title || description, description: title ? description : '' };
}

function normalizeRelease(value, version) {
  const release = {
    headline: `RefBoard ${version}`,
    summary: 'The latest RefBoard changes, collected in one place.',
    sections: emptySections(),
  };

  const legacyList = Array.isArray(value)
    ? value
    : (Array.isArray(value?.highlights) ? value.highlights : null);
  if (legacyList) {
    let activeSection = 'improved';
    for (const raw of legacyList) {
      const text = String(raw || '').trim();
      if (!text) continue;
      if (/^(new|new features?)\s*:?$/i.test(text)) { activeSection = 'new'; continue; }
      if (/^(improved|improvements?)\s*:?$/i.test(text)) { activeSection = 'improved'; continue; }
      if (/^(fixed|fixes|bug fixes?)\s*:?$/i.test(text)) { activeSection = 'fixed'; continue; }
      const item = normalizeItem(text);
      if (item) release.sections[activeSection].push(item);
    }
    return release;
  }

  if (!value || typeof value !== 'object') return release;
  release.headline = String(value.headline || release.headline).trim();
  release.summary = String(value.summary || release.summary).trim();
  for (const key of SECTION_KEYS) {
    const values = Array.isArray(value.sections?.[key]) ? value.sections[key] : [];
    release.sections[key] = values.map(normalizeItem).filter(Boolean);
  }
  return release;
}

function hasContent(release) {
  return SECTION_KEYS.some(key => release.sections[key].length > 0);
}

function assertReleaseReady(release) {
  const problems = [];
  if (!release.headline.trim()) problems.push('headline is empty');
  if (!release.summary.trim()) problems.push('summary is empty');
  for (const key of SECTION_KEYS) {
    for (let index = 0; index < release.sections[key].length; index++) {
      const item = release.sections[key][index];
      if (!item.title.trim()) problems.push(`sections.${key}[${index}].title is empty`);
      if (!item.description.trim()) problems.push(`sections.${key}[${index}].description is empty`);
    }
  }
  if (!problems.length) return;
  console.error('sync-changelog: release notes do not match the structured format:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('See the copy-ready release-highlights.json example in README.md.');
  process.exit(1);
}

function releaseFromFile(version) {
  const filePath = path.join(ROOT, 'release-highlights.json');
  if (!existsSync(filePath)) return normalizeRelease(null, version);
  return normalizeRelease(readJson(filePath, {}), version);
}

function splitTaggedHighlight(body) {
  const [rawTitle, ...descriptionParts] = body.split('|');
  return normalizeItem({
    title: rawTitle,
    description: descriptionParts.join('|'),
  });
}

function highlightsFromGit() {
  const tag = git('git describe --tags --abbrev=0');
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const log = git(`git log ${range} --pretty=%s`);
  if (!log) return [];

  const tagged = [];
  for (const subject of log.split('\n').map(line => line.trim())) {
    const match = subject.match(/^\[highlight(?::(new|improved|fixed))?\]\s*(.+)$/i);
    if (!match) continue;
    const item = splitTaggedHighlight(match[2].trim());
    if (item) tagged.push({ section: (match[1] || 'improved').toLowerCase(), item });
  }
  return tagged;
}

function mergeGitHighlights(release, tagged) {
  const seen = new Set();
  for (const key of SECTION_KEYS) {
    release.sections[key] = release.sections[key].filter(item => {
      const identity = `${key}\n${item.title}\n${item.description}`.toLowerCase();
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }
  for (const { section, item } of tagged) {
    const identity = `${section}\n${item.title}\n${item.description}`.toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    release.sections[section].push(item);
  }
  return release;
}

function sortChangelogKeys(changelog) {
  return Object.keys(changelog).sort((a, b) => {
    if (semverGt(a, b)) return 1;
    if (semverGt(b, a)) return -1;
    return 0;
  });
}

const pkg = readJson(path.join(ROOT, 'package.json'), {});
const version = pkg.version;
if (!version) {
  console.error('sync-changelog: package.json has no version');
  process.exit(1);
}

const changelogPath = path.join(ROOT, 'changelog.json');
const changelog = readJson(changelogPath, {});
if (hasContent(normalizeRelease(changelog[version], version))) {
  console.log(`sync-changelog: changelog.json already has v${version}`);
  process.exit(0);
}

const release = mergeGitHighlights(releaseFromFile(version), highlightsFromGit());
if (!hasContent(release)) {
  const previous = sortChangelogKeys(changelog).filter(v => semverGt(version, v)).pop();
  console.log(`sync-changelog: no release notes for v${version} (previous logged: ${previous || 'none'})`);
  console.log('  -> Edit release-highlights.json before building, or use commits like:');
  console.log('     git commit -m "[highlight:fixed] Export blur | Images now stay crisp."');
  console.log('  -> A release with no entry will not show an in-app What\'s New notice.');
  process.exit(0);
}

assertReleaseReady(release);

changelog[version] = release;
const sorted = {};
for (const key of sortChangelogKeys(changelog)) sorted[key] = changelog[key];
writeFileSync(changelogPath, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');

const total = SECTION_KEYS.reduce((sum, key) => sum + release.sections[key].length, 0);
console.log(`sync-changelog: added v${version} to changelog.json (${total} ${total === 1 ? 'change' : 'changes'})`);
for (const key of SECTION_KEYS) {
  for (const item of release.sections[key]) console.log(`  [${key}] ${item.title}`);
}
