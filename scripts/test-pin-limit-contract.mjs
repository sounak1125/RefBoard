/**
 * The pin limit is written down twice, and both copies have to agree.
 *
 * The landing checks it before calling, so it can say why nothing happened;
 * main enforces it again so two windows cannot pin past it at once. They cannot
 * share a module: the preload is sandboxed, so it can require 'electron' and
 * little else - trying to require the shared file there takes the whole preload
 * down and the app comes up with no RefBoardAPI at all.
 *
 * So the number is duplicated on purpose, and this is what keeps it honest.
 * Raise MAX_PINNED alone and the landing refuses pins main would have allowed;
 * raise PIN_LIMIT alone and the landing says "Pinned" for a pin main threw away.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const { MAX_PINNED } = require('./recent-works.js');
assert.equal(typeof MAX_PINNED, 'number', 'recent-works.js must export MAX_PINNED');
assert.ok(MAX_PINNED > 0, 'the pin limit must be a positive count');

const renderer = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const declared = renderer.match(/const PIN_LIMIT = (\d+);/);
assert.ok(declared, 'index.html must declare PIN_LIMIT as a plain number');
assert.equal(
  Number(declared[1]),
  MAX_PINNED,
  `PIN_LIMIT in index.html (${declared[1]}) must equal MAX_PINNED in scripts/recent-works.js (${MAX_PINNED})`,
);

// The preload must not try to share the module either: it is sandboxed, so a
// require of a local file there is fatal rather than merely unsupported.
const preload = readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const localRequires = [...preload.matchAll(/require\((['"])(\.[^'"]+)\1\)/g)].map(m => m[2]);
assert.deepEqual(
  localRequires,
  [],
  `preload.js is sandboxed and cannot require local modules, but requires ${JSON.stringify(localRequires)} `
  + '- that throws before contextBridge runs and the renderer comes up with no RefBoardAPI',
);

console.log(`pin limit contract: index.html and recent-works.js agree on ${MAX_PINNED}`);
