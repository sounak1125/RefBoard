#!/usr/bin/env node
/**
 * What check-build-files.mjs must keep checking.
 *
 * 2.0.11 shipped an asar with no scripts/recent-works.js in it. main.js had
 * required it since the pinned-boards work; build.files never listed it; the
 * app died on launch with "Cannot find module './scripts/recent-works'". The
 * whole suite was green and so was CI, because the guard walked the module
 * graph from index.html only and matched ESM syntax only - and main.js is
 * CommonJS. Both halves of that blind spot are pinned here.
 *
 * The invariant is also asserted directly, against build.files rather than
 * against the guard's implementation, so this still fails if the guard is
 * rewritten into something that no longer catches it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY_FILES = ['index.html', 'main.js', 'preload.js'];

const guard = fs.readFileSync(path.join(ROOT, 'scripts/check-build-files.mjs'), 'utf8');

// The two holes, named. A guard that reads only index.html cannot see anything
// the main process pulls in, and the main process is where this bug lived.
for (const entry of ENTRY_FILES) {
  assert.match(guard, new RegExp(`'${entry.replace('.', '\\.')}'`), `the guard must walk ${entry}`);
}
assert.match(
  guard,
  /\\brequire\\s\*\\\(/,
  'the guard must match CommonJS require(), not ESM import syntax alone',
);

// Extensionless requires are the easy ones to forget in build.files, so the
// guard skipping them would defeat the point of matching require() at all.
assert.match(guard, /function resolveModuleFile/, 'the guard must resolve extensionless CommonJS specifiers');

function localSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\b(?:import|export)\s+[^;]*?\s+from\s*(['"])(\.\.?\/[^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g,
    /\brequire\s*\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[2]);
  }
  return [...found];
}

function resolveOnDisk(specifier) {
  const base = path.resolve(ROOT, specifier);
  if (/\.(?:mjs|cjs|js)$/i.test(base)) return base;
  for (const candidate of [`${base}.js`, `${base}.mjs`, `${base}.cjs`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return `${base}.js`;
}

function coveredByBuildFiles(relativePath, patterns) {
  let included = false;
  for (const raw of patterns) {
    const excluded = raw.startsWith('!');
    const pattern = excluded ? raw.slice(1) : raw;
    if (path.matchesGlob(relativePath, pattern)) included = !excluded;
  }
  return included;
}

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const patterns = (packageJson?.build?.files || []).filter(entry => typeof entry === 'string');
assert.ok(patterns.length, 'build.files must hold string patterns');

// The invariant itself: anything an entry point pulls in has to be packaged,
// or the installed app cannot start. Checked here independently of the guard.
let checked = 0;
for (const entry of ENTRY_FILES) {
  const source = fs.readFileSync(path.join(ROOT, entry), 'utf8');
  for (const specifier of localSpecifiers(source)) {
    const absolute = resolveOnDisk(specifier);
    const relative = path.relative(ROOT, absolute).replace(/\\/g, '/');
    assert.ok(fs.existsSync(absolute), `${entry} requires ${specifier}, which is not on disk (${relative})`);
    assert.ok(
      coveredByBuildFiles(relative, patterns),
      `${entry} requires ${specifier} but build.files does not package ${relative} - the installed app will die on launch`,
    );
    checked++;
  }
}
assert.ok(checked > 0, 'the entry points should pull in at least one local module');

// The specific file that shipped missing, named so the regression is unmistakable.
assert.ok(
  coveredByBuildFiles('scripts/recent-works.js', patterns),
  'scripts/recent-works.js must stay in build.files - leaving it out is what broke 2.0.11',
);

console.log(`build-files guard contract ok - ${checked} entry-point modules packaged, require() and main.js both covered`);
