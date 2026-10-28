/**
 * An update brings RefBoard back up after it installs.
 *
 * Through 2.1.6, "Restart to update" closed the app and nothing reopened it:
 * quitAndInstall() ran the windowed installer, electron-builder's assisted
 * installer only honours --force-run when silent, and our customFinishPage
 * replaced the stock finish page together with its "Run RefBoard" checkbox.
 * The finish page fix reaches users on their next update (the new installer
 * runs it); the silent relaunch covers updates started from builds with this fix.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8');
const [nsh, main] = await Promise.all([read('build/installer.nsh'), read('main.js')]);

const finish = /!macro customFinishPage([\s\S]*?)!macroend/.exec(nsh);
assert.ok(finish, 'installer.nsh should define customFinishPage');
const page = finish[1];
assert.match(page, /!define MUI_FINISHPAGE_RUN\s*$/m, 'the finish page must offer to run RefBoard');
assert.match(page, /!define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"/, 'the run checkbox must launch through StartApp');
assert.match(page, /Function StartApp[\s\S]*?\$launchLink[\s\S]*?FunctionEnd/, 'StartApp must open the installed shortcut');
assert.ok(page.indexOf('MUI_FINISHPAGE_RUN') < page.indexOf('MUI_PAGE_FINISH'), 'the run settings must come before the finish page is inserted');

assert.match(main, /autoUpdater\.quitAndInstall\(true, true\)/, 'Restart to update must install silently and relaunch');
assert.doesNotMatch(main, /autoUpdater\.quitAndInstall\(\s*\)/, 'a windowed install leaves the app closed');

console.log('update relaunch passed — finish page runs RefBoard, Restart to update relaunches silently');
