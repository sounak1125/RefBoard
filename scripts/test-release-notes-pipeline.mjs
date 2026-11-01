#!/usr/bin/env node
/**
 * The release-notes pipeline, run for real on a scratch copy of the repo:
 * sync-changelog.mjs carries where, note and details into changelog.json and
 * refuses notes over the limits, and ship-release.ps1 -DryRun puts all three on
 * the change's line of the GitHub release text. Both scripts read the folder
 * they run from, so the repo's own changelog.json is never touched.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'refboard-release-notes-'));

const release = {
  headline: 'Remove objects from images',
  summary: 'Draw around anything in an image and RefBoard paints it out.',
  sections: {
    new: [{
      title: 'Remove object',
      description: 'Draw around anything in an image, and RefBoard paints it out.',
      where: 'Selection bar or right-click menu',
      note: 'The first use downloads a 208 MB model once',
      details: 'Press Enter to apply or Esc to cancel.',
    }],
    improved: [],
    fixed: [{ title: 'A fix', description: 'What now works.' }],
  },
};

const writeJson = (name, value) => writeFile(path.join(scratch, name), `${JSON.stringify(value, null, 2)}\n`);
const readChangelog = async () => JSON.parse(await readFile(path.join(scratch, 'changelog.json'), 'utf8'));

// GIT_DIR points nowhere, so sync-changelog finds no tagged commits and the
// result depends only on the files written here.
const run = (command, args) => spawnSync(command, args, {
  cwd: scratch,
  encoding: 'utf8',
  env: { ...process.env, GIT_DIR: path.join(scratch, 'no-git') },
});
const sync = () => run(process.execPath, [path.join(scratch, 'scripts', 'sync-changelog.mjs')]);

try {
  await mkdir(path.join(scratch, 'scripts'));
  for (const file of ['sync-changelog.mjs', 'release-notes-rules.mjs', 'ship-release.ps1']) {
    await copyFile(path.join(root, 'scripts', file), path.join(scratch, 'scripts', file));
  }
  await writeJson('package.json', { version: '9.9.0' });
  await writeJson('changelog.json', {});
  await writeJson('release-highlights.json', release);

  const synced = sync();
  assert.equal(synced.status, 0, `sync-changelog failed:\n${synced.stdout}${synced.stderr}`);
  const entry = (await readChangelog())['9.9.0'];
  assert.deepEqual(entry.sections.new[0], release.sections.new[0], 'sync-changelog carries where, note and details into changelog.json');
  assert.deepEqual(entry.sections.fixed[0], release.sections.fixed[0], 'a change without them is copied as it was');

  const ship = run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(scratch, 'scripts', 'ship-release.ps1'), '-DryRun']);
  assert.equal(ship.status, 0, `ship-release.ps1 -DryRun failed:\n${ship.stdout}${ship.stderr}`);
  const notes = ship.stdout.replace(/\r\n/g, '\n');
  assert.match(
    notes,
    /^- \*\*Remove object\*\* - Draw around anything in an image, and RefBoard paints it out\. Press Enter to apply or Esc to cancel\. Find it: Selection bar or right-click menu\. Note: The first use downloads a 208 MB model once\.$/m,
    `the GitHub release puts details, where and note on the change's line:\n${notes}`,
  );
  assert.match(notes, /^- \*\*A fix\*\* - What now works\.$/m, 'a change without them keeps its one line');

  const tooLong = structuredClone(release);
  tooLong.sections.new[0].description = 'x'.repeat(91);
  tooLong.sections.new[0].detail = 'a misspelt details';
  await writeJson('changelog.json', {});
  await writeJson('release-highlights.json', tooLong);
  const refused = sync();
  assert.notEqual(refused.status, 0, 'sync-changelog refuses a description over the limit');
  assert.match(refused.stderr, /sections\.new\[0\]\.description is 91 characters/, 'and names the field');
  assert.match(refused.stderr, /sections\.new\[0\]\.detail is not a release-note field/, 'a misspelt field is refused, not dropped');
  assert.deepEqual(await readChangelog(), {}, 'and nothing is written');

  console.log('release notes pipeline ok - sync carries where, note and details, refuses long notes, and the GitHub text shows all three');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
