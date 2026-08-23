import { rm } from 'node:fs/promises';

/**
 * Remove an Electron smoke-test profile directory, tolerating Windows holding
 * Chromium's handles open for a moment after the process exits.
 *
 * `rm(profile, { recursive: true, force: true })` immediately after killing
 * Electron throws EBUSY on Windows — typically on `Network\Trust Tokens-journal`
 * or a leveldb LOCK. That surfaced as a CI failure on a test whose assertions
 * had all already passed, which is the worst kind of red: it says the code is
 * broken when only the teardown is.
 *
 * A leftover temp directory is not a test result. Retry for a while, then warn
 * and carry on — the OS and the CI runner both discard the temp tree anyway.
 *
 * @param {string} dir profile directory to remove
 * @returns {Promise<boolean>} whether the directory was actually removed
 */
export async function removeProfileDir(dir, { attempts = 12, waitMs = 250 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (attempt === attempts - 1) {
        console.warn(`[smoke] left ${dir} behind: ${err?.code || err?.message || err}`);
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
  return false;
}
