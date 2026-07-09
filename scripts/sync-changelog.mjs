#!/usr/bin/env node
/**
 * Before dist: if package.json version is new vs changelog.json, copy highlights
 * from release-highlights.json and/or git commits tagged [highlight] …
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function parseSemver(v) {
  const m = String(v || '').trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function semverGt(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

function git(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function highlightsFromFile() {
  const filePath = path.join(ROOT, 'release-highlights.json');
  if (!existsSync(filePath)) return [];
  const data = readJson(filePath, {});
  const list = Array.isArray(data) ? data : data.highlights;
  if (!Array.isArray(list)) return [];
  return list.map(s => String(s).trim()).filter(Boolean);
}

function highlightsFromGit() {
  const tag = git('git describe --tags --abbrev=0');
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const log = git(`git log ${range} --pretty=%s`);
  if (!log) return [];
  return log
    .split('\n')
    .map(s => s.trim())
    .filter(s => /^\[highlight\]/i.test(s))
    .map(s => s.replace(/^\[highlight\]\s*/i, '').trim())
    .filter(Boolean);
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

if (Array.isArray(changelog[version]) && changelog[version].length) {
  console.log(`sync-changelog: changelog.json already has v${version}`);
  process.exit(0);
}

const fromFile = highlightsFromFile();
const fromGit = highlightsFromGit();
const highlights = [...new Set([...fromFile, ...fromGit])];

if (!highlights.length) {
  const prev = sortChangelogKeys(changelog).filter(v => semverGt(version, v)).pop();
  console.log(`sync-changelog: no highlights for v${version} (previous logged: ${prev || 'none'})`);
  console.log('  → Edit release-highlights.json before npm run dist, or use commits like:');
  console.log('     git commit -m "[highlight] Hand tool on the left drawer"');
  console.log('  → Patch releases with no entry = no in-app What\'s New notice.');
  process.exit(0);
}

changelog[version] = highlights;
const sorted = {};
for (const key of sortChangelogKeys(changelog)) sorted[key] = changelog[key];
writeFileSync(changelogPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');

console.log(`sync-changelog: added v${version} to changelog.json (${highlights.length} highlight${highlights.length === 1 ? '' : 's'})`);
for (const h of highlights) console.log(`  • ${h}`);
