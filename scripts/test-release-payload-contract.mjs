import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ship = await readFile(new URL('../scripts/ship-release.ps1', import.meta.url), 'utf8');
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

// Slice the function by matching braces, so reordering the file's functions
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

const body = functionBody(ship, 'Assert-BootstrapperPayload');

// The bootstrapper payload does not refresh itself, so shipping without this
// check produces a correctly named installer that installs the previous
// version. This happened while shipping 2.0.8.
assert.match(ship, /\[switch\]\$SkipPayloadCheck/, 'the opt-out switch must stay declared');
assert.match(
  ship,
  /if \(-not \$SkipPayloadCheck\) \{\s*\r?\n\s*Assert-BootstrapperPayload -SetupPath \$setup -DistDir \$DistDir -Version \$version/,
  'the check must run by default, opting out only via -SkipPayloadCheck',
);

// Checking bootstrapper/payload alone is not enough: a payload refreshed
// without rebuilding the bootstrapper matches while the installer does not.
// win-unpacked holds what the portable exe actually wrapped.
assert.match(body, /'win-unpacked'/, 'the check must read the copy the installer actually wrapped');
assert.match(body, /'resources'/, 'the embedded copy lives under win-unpacked/resources');
assert.match(
  body,
  /LastWriteTimeUtc[\s\S]*?-lt[\s\S]*?LastWriteTimeUtc/,
  'the payload-file fallback must reject an installer older than the payload',
);
assert.match(body, /Get-FileHash[\s\S]*?Get-FileHash/, 'both sides must be hashed and compared');
assert.match(body, /-ne \$checkedHash/, 'a hash mismatch must be the failure condition');

// A missing installer is not an error: publish-local-dist.ps1 already skips it.
assert.match(body, /Write-Warning[^\r\n]*will be skipped/, 'an unbuilt bootstrapper warns rather than failing');

// Ordering is the part a name-only test would miss. The check is worthless if it
// runs after the release exists or after the assets are already uploaded.
const at = needle => {
  const i = ship.indexOf(needle);
  assert.notEqual(i, -1, `ship-release.ps1 should still contain ${needle}`);
  return i;
};
const artifactLoop = at('foreach ($path in @($setup, $blockmap, $latest))');
const checkCall = at('Assert-BootstrapperPayload -SetupPath $setup');
const createRelease = at("'release', 'create'");
const uploadAssets = at('publish-local-dist.ps1');
assert.ok(artifactLoop < checkCall, 'the check must run after $setup is known to exist');
assert.ok(checkCall < createRelease, 'the check must run before the release is created');
assert.ok(checkCall < uploadAssets, 'the check must run before any asset is uploaded');

// -DryRun only prints notes, so it must return before the check needs artifacts.
assert.ok(at('if ($DryRun)') < checkCall, '-DryRun must return before the payload check');

// The failure mode is now reachable by the person running a release.
assert.match(readme, /-SkipPayloadCheck/, 'README must document the opt-out switch');

console.log('release payload contract ok - check is default-on, authoritative, and ordered before upload');
