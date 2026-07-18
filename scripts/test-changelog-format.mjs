#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECTION_KEYS = ['new', 'improved', 'fixed'];

function readJson(fileName) {
  return JSON.parse(readFileSync(path.join(ROOT, fileName), 'utf8'));
}

function validateRelease(release, label) {
  assert(release && typeof release === 'object' && !Array.isArray(release), `${label} must be an object`);
  assert.equal(typeof release.headline, 'string', `${label}.headline must be a string`);
  assert(release.headline.trim(), `${label}.headline cannot be empty`);
  assert.equal(typeof release.summary, 'string', `${label}.summary must be a string`);
  assert(release.summary.trim(), `${label}.summary cannot be empty`);
  assert(release.sections && typeof release.sections === 'object', `${label}.sections must be an object`);

  let total = 0;
  for (const key of SECTION_KEYS) {
    const items = release.sections[key];
    assert(Array.isArray(items), `${label}.sections.${key} must be an array`);
    total += items.length;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const itemLabel = `${label}.sections.${key}[${index}]`;
      assert(item && typeof item === 'object' && !Array.isArray(item), `${itemLabel} must be an object`);
      assert.equal(typeof item.title, 'string', `${itemLabel}.title must be a string`);
      assert(item.title.trim(), `${itemLabel}.title cannot be empty`);
      assert.equal(typeof item.description, 'string', `${itemLabel}.description must be a string`);
      assert(item.description.trim(), `${itemLabel}.description cannot be empty`);
    }
  }
  assert(total > 0, `${label} must contain at least one change`);
}

const changelog = readJson('changelog.json');
assert(changelog && typeof changelog === 'object' && !Array.isArray(changelog), 'changelog.json must be an object');
const versions = Object.keys(changelog);
assert(versions.length > 0, 'changelog.json must contain at least one release');
for (const version of versions) {
  assert(/^\d+\.\d+\.\d+$/.test(version), `Invalid changelog version: ${version}`);
  validateRelease(changelog[version], `changelog.json[${JSON.stringify(version)}]`);
}

validateRelease(readJson('release-highlights.json'), 'release-highlights.json');
console.log(`changelog format: ok (${versions.length} releases)`);
