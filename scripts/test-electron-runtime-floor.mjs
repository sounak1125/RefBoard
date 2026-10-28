/**
 * The shipped Electron runtime stays at or above the last security floor, and
 * the bootstrapper ships the same runtime as the app.
 *
 * 2.1.6 shipped Electron 44.4.5, which still trusted the compromised eMudhra
 * intermediates (GHSA-jr5w-w6x2-84p9, fixed in 44.9.1). The setup is unsigned,
 * so the update check's TLS is all that vouches for a downloaded installer.
 * Electron is a devDependency, so `npm audit --omit=dev` never reports it; this
 * keeps the floor where `npm test` sees it. Raise FLOOR with the next advisory.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const FLOOR = [44, 9, 1];
const read = async rel => JSON.parse(await readFile(new URL(`../${rel}`, import.meta.url), 'utf8'));

function parse(version, where) {
  const m = /^\^?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  assert.ok(m, `${where}: expected an exact or caret version, got ${version}`);
  return m.slice(1).map(Number);
}

function atLeastFloor(version) {
  for (let i = 0; i < 3; i++) if (version[i] !== FLOOR[i]) return version[i] > FLOOR[i];
  return true;
}

const locked = {};
for (const [name, dir] of [['app', ''], ['bootstrapper', 'bootstrapper/']]) {
  const pkg = await read(`${dir}package.json`);
  const lock = await read(`${dir}package-lock.json`);
  const range = pkg.devDependencies?.electron;
  assert.ok(range, `${name}: electron should stay a devDependency`);
  // The range's own floor matters too: an install without the lockfile takes it.
  assert.ok(atLeastFloor(parse(range, `${name} package.json`)), `${name}: electron ${range} admits versions below ${FLOOR.join('.')}`);
  assert.equal(lock.packages[''].devDependencies?.electron, range, `${name}: package-lock.json is out of step with package.json`);
  const version = lock.packages['node_modules/electron']?.version;
  assert.ok(version, `${name}: package-lock.json should resolve electron`);
  assert.ok(atLeastFloor(parse(version, `${name} package-lock.json`)), `${name}: locked electron ${version} is below ${FLOOR.join('.')}`);
  locked[name] = version;
}
assert.equal(locked.bootstrapper, locked.app, 'the bootstrapper should lock the same Electron as the app');

console.log(`electron runtime floor passed — app and bootstrapper both lock ${locked.app} (floor ${FLOOR.join('.')})`);
