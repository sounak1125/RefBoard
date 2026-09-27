'use strict';

// Verify the actual release files before uploading them. This never installs
// the app or changes an existing GitHub release.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const asar = require('@electron/asar');
const yaml = require('js-yaml');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const appArchive = path.join(dist, 'win-unpacked/resources/app.asar');
const installerArchive = path.join(dist, 'bootstrapper/win-unpacked/resources/app.asar');
const readPackedJson = (archive, file) => JSON.parse(asar.extractFile(archive, file));
const hash = (file, algorithm = 'sha256', encoding = 'hex') =>
  crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);

assert.equal(readPackedJson(appArchive, 'package.json').version, version);
assert.equal(readPackedJson(installerArchive, 'package.json').version, version);
for (const file of pkg.build.files.filter(file => !file.includes('*') && file !== 'package.json')) {
  assert.ok(asar.extractFile(appArchive, file).equals(fs.readFileSync(path.join(root, file))),
    `Packaged source differs from checkout: ${file}`);
}
for (const file of ['main.js', 'preload.js']) {
  assert.ok(asar.extractFile(installerArchive, file).equals(fs.readFileSync(path.join(root, 'bootstrapper', file))),
    `Packaged installer source differs from checkout: ${file}`);
}
for (const file of ['app.js', 'styles.css']) {
  assert.ok(asar.extractFile(installerArchive, `ui/${file}`).equals(fs.readFileSync(path.join(root, 'build/installer-ui', file))),
    `Packaged installer UI differs from canonical source: ${file}`);
}
assert.ok(asar.extractFile(installerArchive, 'ui/index.html').toString().includes(`Version ${version}`),
  'Installer UI must display the release version');
for (const file of ['RefBoardThumbnailHandler.dll', 'SharpShell.dll', 'scripts/register-thumb-handler.ps1']) {
  assert.ok(fs.statSync(path.join(dist, 'win-unpacked/resources', file)).size > 0, file);
}

const feed = yaml.load(fs.readFileSync(path.join(dist, 'latest.yml'), 'utf8'));
const setupName = `RefBoard-Setup-${version}.exe`;
const setup = path.join(dist, setupName);
assert.equal(feed.version, version);
assert.equal(feed.path, setupName);
assert.equal(feed.sha512, hash(setup, 'sha512', 'base64'));
assert.equal(feed.files.length, 1);
assert.equal(feed.files[0].url, setupName);
assert.equal(feed.files[0].sha512, feed.sha512);
assert.equal(feed.files[0].size, fs.statSync(setup).size);
for (const payload of [
  path.join(root, 'bootstrapper/payload/RefBoard-Setup.exe'),
  path.join(dist, 'bootstrapper/win-unpacked/resources/RefBoard-Setup.exe'),
]) assert.equal(hash(payload), hash(setup), 'The installer must wrap this exact setup');

const files = [setupName, `${setupName}.blockmap`, 'latest.yml', `bootstrapper/RefBoard-Installer-${version}.exe`];
const artifacts = files.map(file => {
  const absolute = path.join(dist, file);
  const bytes = fs.statSync(absolute).size;
  assert.ok(bytes > 0, `Empty release artifact: ${file}`);
  return { file, bytes, sha256: hash(absolute) };
});
const manifest = {
  version,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  packagedSourcesMatch: true, bootstrapperPayloadMatches: true, updateFeedMatches: true,
  artifacts,
};
fs.writeFileSync(path.join(dist, `release-${version}-manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
fs.writeFileSync(path.join(dist, `SHA256SUMS-${version}.txt`), artifacts.map(item => `${item.sha256}  ${item.file}`).join('\n') + '\n');
console.log(JSON.stringify(manifest, null, 2));
