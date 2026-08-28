import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ship = await readFile(new URL('../scripts/ship-release.ps1', import.meta.url), 'utf8');
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

// Slice a function by matching braces, so reordering the file's functions
// cannot silently turn these assertions into no-ops.
function functionBody(src, name) {
  const start = src.indexOf(`function ${name} {`);
  assert.notEqual(start, -1, `ship-release.ps1 must define ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${name} has unbalanced braces`);
}

const sync = functionBody(ship, 'Sync-BootstrapperPayload');
const wrapped = functionBody(ship, 'Get-WrappedSetup');

// The bootstrapper payload does not refresh itself, so shipping without this
// step produces a correctly named installer that installs the previous
// version. This happened while shipping 2.0.8.
assert.match(ship, /\[switch\]\$SkipPayloadCheck/, 'the skip switch must stay declared');
assert.match(ship, /\[switch\]\$NoBootstrapperRebuild/, 'the no-rebuild switch must stay declared');
assert.match(
  ship,
  /if \(-not \$SkipPayloadCheck\) \{\s*\r?\n\s*Sync-BootstrapperPayload -SetupPath \$setup -DistDir \$DistDir -Version \$version -NoRebuild:\$NoBootstrapperRebuild/,
  'the sync must run by default, opting out only via the two switches',
);

// What the installer wraps is decided by the copy it was built around, not by
// the payload file, which can be newer than the installer.
assert.match(wrapped, /'win-unpacked'/, 'the wrapped setup must come from the copy the installer was built around');
assert.match(wrapped, /'resources'/, 'the embedded copy lives under win-unpacked/resources');
assert.match(
  wrapped,
  /LastWriteTimeUtc[\s\S]*?-lt[\s\S]*?LastWriteTimeUtc/,
  'the payload-file fallback must reject an installer older than the payload',
);

// The automated refresh: copy the built setup in, then rebuild around it.
assert.match(sync, /Copy-Item -LiteralPath \$SetupPath -Destination \$payload -Force/, 'the refresh must copy the built setup into the payload');
assert.match(sync, /& npm run dist/, 'the refresh must actually invoke the bootstrapper build');
assert.match(sync, /\$buildExit -ne 0/, 'a failed bootstrapper build must abort the release');

// The invariant that makes automation safe rather than merely convenient: a
// rebuild is not evidence. Without a hash check after the build, a build that
// silently wrapped the wrong file would now be uploaded unnoticed - strictly
// worse than the manual step it replaced.
const buildAt = sync.indexOf('& npm run dist');
const verifyAt = sync.indexOf('-ne $setupHash');
assert.notEqual(verifyAt, -1, 'the rebuilt installer must be hash-checked against the setup');
assert.ok(buildAt < verifyAt, 'the hash check must run after the rebuild, not only before it');
assert.match(
  sync.slice(buildAt),
  /Get-WrappedSetup[\s\S]*?-ne \$setupHash/,
  'the post-rebuild check must re-resolve what the installer wraps, not reuse the stale result',
);

// A missing installer is not an error: publish-local-dist.ps1 already skips it.
assert.match(sync, /Write-Warning[^\r\n]*will be skipped/, 'an unbuilt bootstrapper warns rather than failing');

// Ordering is the part a name-only test would miss. Any of this is worthless if
// it runs after the release exists or after the assets are already uploaded.
const at = needle => {
  const i = ship.indexOf(needle);
  assert.notEqual(i, -1, `ship-release.ps1 should still contain ${needle}`);
  return i;
};
const artifactLoop = at('foreach ($path in @($setup, $blockmap, $latest))');
const syncCall = at('Sync-BootstrapperPayload -SetupPath $setup');
const createRelease = at("'release', 'create'");
const uploadAssets = at('publish-local-dist.ps1');
assert.ok(artifactLoop < syncCall, 'the sync must run after $setup is known to exist');
assert.ok(syncCall < createRelease, 'the sync must run before the release is created');
assert.ok(syncCall < uploadAssets, 'the sync must run before any asset is uploaded');

// -DryRun only prints notes, so it must return before any of this.
assert.ok(at('if ($DryRun)') < syncCall, '-DryRun must return before the payload sync');

// Both failure modes stay reachable by the person running a release.
assert.match(readme, /-SkipPayloadCheck/, 'README must document the skip switch');
assert.match(readme, /-NoBootstrapperRebuild/, 'README must document the no-rebuild switch');

/* The bootstrapper names its artifact from its own package.json version while
   this script looks for the root version's name, so a release where only the
   root was bumped ships with no installer — and only warns about it. That trap
   is invisible from the scripts alone, so the README has to call it out. */
assert.match(
  readme,
  /bootstrapper\/package\.json/,
  'README must tell the releaser to bump bootstrapper/package.json too',
);
assert.match(
  ship,
  /Write-Warning "No \$installerName built/,
  'a missing installer must stay a warning, which is exactly why the README has to flag the version bump',
);

console.log('release payload contract ok - sync is default-on, ordered before upload, and re-verified after rebuild');
