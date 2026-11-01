#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SECTION_KEYS, isShortNotesRelease, releaseNoteProblems } from './release-notes-rules.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(fileName) {
  return JSON.parse(readFileSync(path.join(ROOT, fileName), 'utf8'));
}

function validateRelease(release, label, { short }) {
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

  const problems = releaseNoteProblems(release, { short });
  assert.equal(problems.length, 0, `${label} breaks the release-notes format:\n  - ${problems.join('\n  - ')}`);
}

// The rules have to reject what they claim to. One that accepted everything
// would keep this test green while it checked nothing.
function sampleRelease() {
  return {
    headline: 'A short headline',
    summary: 'One sentence about the update.',
    sections: { new: [{ title: 'A change', description: 'What it does.' }], improved: [], fixed: [] },
  };
}
assert.deepEqual(releaseNoteProblems(sampleRelease(), { short: true }), [], 'a short release passes');
for (const [change, expected] of [
  [release => { release.headline = 'x'.repeat(51); }, /^headline is 51 characters/],
  [release => { release.summary = 'x'.repeat(121); }, /^summary is 121 characters/],
  [release => { release.sections.new[0].title = 'x'.repeat(41); }, /\.title is 41 characters/],
  [release => { release.sections.new[0].description = 'x'.repeat(91); }, /\.description is 91 characters/],
  [release => { release.sections.new[0].where = 'x'.repeat(41); }, /\.where is 41 characters/],
  [release => { release.sections.new[0].note = 'x'.repeat(91); }, /\.note is 91 characters/],
  [release => { release.sections.new[0].note = '   '; }, /\.note must be text/],
  [release => { release.sections.new[0].details = 3; }, /\.details must be text/],
  [release => { release.sections.new[0].detail = 'a misspelt details'; }, /\.detail is not a release-note field/],
]) {
  const release = sampleRelease();
  change(release);
  const problems = releaseNoteProblems(release, { short: true });
  assert(problems.some(problem => expected.test(problem)), `the rules should report ${expected}, got ${JSON.stringify(problems)}`);
}
const longDetails = sampleRelease();
longDetails.sections.new[0].details = 'x'.repeat(600);
assert.deepEqual(releaseNoteProblems(longDetails, { short: true }), [], 'details has no limit: it only goes to GitHub');
const olderRelease = sampleRelease();
olderRelease.sections.new[0].description = 'x'.repeat(300);
assert.deepEqual(releaseNoteProblems(olderRelease, { short: false }), [], 'releases from before the limits keep their notes');
assert.equal(isShortNotesRelease('2.1.6'), false, '2.1.6 shipped before the limits');
assert.equal(isShortNotesRelease('2.2.0'), true, 'the limits start at 2.2.0');
assert.equal(isShortNotesRelease('2.10.0'), true, 'versions compare as numbers, not text');

const changelog = readJson('changelog.json');
assert(changelog && typeof changelog === 'object' && !Array.isArray(changelog), 'changelog.json must be an object');
const versions = Object.keys(changelog);
assert(versions.length > 0, 'changelog.json must contain at least one release');
let shortReleases = 0;
for (const version of versions) {
  assert(/^\d+\.\d+\.\d+$/.test(version), `Invalid changelog version: ${version}`);
  const short = isShortNotesRelease(version);
  if (short) shortReleases++;
  validateRelease(changelog[version], `changelog.json[${JSON.stringify(version)}]`, { short });
}

// release-highlights.json always holds the next release, so it always gets the limits.
validateRelease(readJson('release-highlights.json'), 'release-highlights.json', { short: true });
console.log(`changelog format: ok (${versions.length} releases, ${shortReleases} held to the short-note limits)`);
