/**
 * Session autosave must never report success it did not achieve.
 *
 * Before this contract existed, `dbPut` swallowed every IndexedDB error and
 * resolved `false`, `persistBoardNow` passed that straight through, and
 * `runAutosaveTick` wrapped the call in `try {} catch { ignore }` and then
 * toasted "Session autosaved" unconditionally. A board that failed to persist —
 * quota exhausted, disk full, database closed — looked saved to the user.
 *
 * These are source-level assertions rather than a running test because the
 * failure only reproduces against a real IndexedDB under storage pressure,
 * which no headless harness reproduces reliably. The shapes asserted here are
 * the ones that made the bug possible.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

/* --- the write path must report why it failed --- */
assert.match(
  html,
  /const dbPutChecked = \(store, key, val\) => new Promise\(res => \{/,
  'a checked write helper must exist so failures carry an error',
);
assert.match(
  html,
  /tx\.onabort = \(\) => res\(\{ ok: false, error: tx\.error \}\);/,
  'an aborted transaction (how quota exhaustion surfaces) must report its error',
);
assert.match(
  html,
  /const dbPut = async \(store, key, val\) => \(await dbPutChecked\(store, key, val\)\)\.ok;/,
  'dbPut must keep its boolean contract for incidental callers',
);
assert.match(
  html,
  /return dbPutChecked\('meta', SESSION_META_KEY, \{/,
  'the session autosave must use the checked write',
);

/* --- the autosave tick must branch on the outcome --- */
const tick = html.match(/async function runAutosaveTick\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(tick, 'runAutosaveTick should be findable');
assert.doesNotMatch(
  tick,
  /catch \{ \/\* ignore \*\/ \}/,
  'the autosave tick must not swallow persistence errors',
);
assert.match(
  tick,
  /if \(!result\?\.ok\) \{\s*\r?\n\s*reportSessionPersistFailure\(result\?\.error\);\s*\r?\n\s*return;/,
  'a failed autosave must report and must not fall through to the success toast',
);
const successToast = tick.indexOf("toast('Session autosaved')");
const failureReturn = tick.indexOf('reportSessionPersistFailure');
assert.ok(failureReturn !== -1 && successToast !== -1, 'both paths should exist');
assert.ok(
  failureReturn < successToast,
  'the failure branch must return before the "Session autosaved" toast can run',
);

/* --- the debounced save path must not swallow failures either --- */
const schedule = html.match(/function scheduleSave\(markDirty = true\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(schedule, 'scheduleSave should be findable');
assert.match(
  schedule,
  /reportSessionPersistFailure/,
  'the debounced save must surface persistence failures too',
);

/* --- the warning must stay put and offer a real recovery --- */
const reporter = html.match(/function reportSessionPersistFailure\(error\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(reporter, 'reportSessionPersistFailure should be findable');
assert.match(reporter, /sticky: true/, 'the warning must not auto-dismiss');
assert.match(reporter, /actionLabel: 'Save board…'/, 'the warning must offer a file save as recovery');
assert.match(
  reporter,
  /QuotaExceededError/,
  'running out of storage should be named explicitly rather than reported generically',
);

/* --- a sticky toast must genuinely skip the dismiss timer --- */
const toastFn = html.match(/function toast\(msg, opts\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(toastFn, 'toast should be findable');
assert.match(
  toastFn,
  /if \(opts\?\.sticky\) return;\s*\r?\n\s*const duration/,
  'sticky toasts must return before the auto-dismiss timer is armed',
);
assert.match(html, /function hideToast\(\) \{/, 'a sticky toast needs an explicit dismissal');

console.log('autosave failure contract tests passed');
