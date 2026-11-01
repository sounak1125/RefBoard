/**
 * Settings page contract (index.html): every control is in the markup once,
 * wired, and reflected back by syncSettingsUi; the page keeps the hooks other
 * tests and the Snip recorder rely on; Restore defaults asks first; the
 * autosave interval is inline (the old pop-up is gone); search covers every
 * pane; the dropdown menu's shadow stays short.
 *
 * Usage: node scripts/test-settings-page.mjs [index.html]
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Checkouts here are CRLF (core.autocrlf); every anchor below is written with \n.
const html = readFileSync(process.argv[2] || path.join(root, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  const a = html.indexOf(start);
  assert.ok(a >= 0, `${what}: start anchor not found`);
  const b = html.indexOf(end, a + start.length);
  assert.ok(b >= 0, `${what}: end anchor not found`);
  return html.slice(a, b + end.length);
}
const fn = name => slice(`function ${name}(`, '\n}\n', name);

const markup = slice('<div id="settingsModal" class="modal">', '\n<div id="exportModal" class="modal">', 'Settings markup');
const wire = fn('wireSettingsControls');
const sync = fn('syncSettingsUi');
const system = slice('async function syncSystemUi() {', '\n}\n', 'syncSystemUi');

/* Panes, in order, with General first. */
const tabs = [...markup.matchAll(/<button class="s2-tab[^"]*" data-pane="(\w+)">/g)].map(m => m[1]);
assert.deepEqual(tabs, ['general', 'appearance', 'performance', 'shortcuts', 'system'], 'the nav lists the five panes');
assert.match(markup, /<button class="s2-tab active" data-pane="general">/, 'Settings opens on General');
for (const pane of tabs) assert.match(markup, new RegExp(`<div class="s2-pane" data-pane="${pane}" data-desc="[^"]+"`), `${pane} has a pane with a description`);

/* Every control: once in the markup, wired, shown back. */
const controls = {
  // id: [what wires it, what shows its state]
  setAutosave: [/'setAutosave'\)\.addEventListener\('click', \(\) => setAutosaveChoice\(\{ autosave: !appSettings\.autosave \}\)\)/, /\$\$\('setAutosave'\)\.classList\.toggle\('on', appSettings\.autosave\)/],
  setWarnLarge: [/toggle\('setWarnLarge', 'warnLargeImages'\)/, /\$\$\('setWarnLarge'\)\.classList\.toggle\('on', appSettings\.warnLargeImages\)/],
  setLargeMP: [/'setLargeMP'\)\.addEventListener\('change'/, /\$\$\('setLargeMP'\)\.value = appSettings\.largeImageMP/],
  setThumbs: [/toggle\('setThumbs', 'generateThumbnails'\)/, /\$\$\('setThumbs'\)\.classList\.toggle\('on', appSettings\.generateThumbnails\)/],
  setPauseHidden: [/toggle\('setPauseHidden', 'pauseWhenHidden'\)/, /\$\$\('setPauseHidden'\)\?\.classList\.toggle\('on', appSettings\.pauseWhenHidden\)/],
  setHideGridNav: [/toggle\('setHideGridNav', 'hideGridWhileNavigating'\)/, /\$\$\('setHideGridNav'\)\?\.classList\.toggle\('on', appSettings\.hideGridWhileNavigating\)/],
  setLightDrag: [/toggle\('setLightDrag', 'lightDragPreview'\)/, /\$\$\('setLightDrag'\)\?\.classList\.toggle\('on', appSettings\.lightDragPreview\)/],
  setUndoLimit: [/'setUndoLimit'\)\.addEventListener\('change'/, /\$\$\('setUndoLimit'\)\.value = appSettings\.undoLimit/],
  setRenderQuality: [/'setRenderQuality'\)\.addEventListener\('change'/, /\$\$\('setRenderQuality'\)\.value = appSettings\.renderQuality/],
  setImageMemory: [/'setImageMemory'\)\.addEventListener\('change'/, /\$\$\('setImageMemory'\)\.value = String\(appSettings\.imageMemoryMB\)/],
  setGridStyle: [/gridStyleSel\.addEventListener\('change', e => setGridAppearance\(e\.target\.value\)\)/, /gridStyleSel\.value = state\.gridAppearance/],
  setLandingLayout: [/landingLayoutSel\.addEventListener\('change', e => setLandingLayout\(e\.target\.value\)\)/, /landingLayoutSel\.value = normalizeLandingLayout/],
  setToolbarMode: [/toolbarModeSel\.addEventListener\('change', e => \{\n    appSettings\.toolbarMode = normalizeToolbarMode\(e\.target\.value\);\n    saveAppSettings\(\);\n    applyToolbarMode\(\);/, /toolbarModeSel\.value = normalizeToolbarMode\(appSettings\.toolbarMode\)/],
  setCheckOnStartup: [/toggle\('setCheckOnStartup', 'checkUpdatesOnStartup'\)/, null],
  setCheckUpdates: [/'setCheckUpdates'\)\?\.addEventListener\('click'/, null],
  settingsWhatsNew: [/\$\('#settingsWhatsNew'\)\.addEventListener\('click', \(\) => \{ void openCurrentWhatsNew\(\); \}\)/, null],
  settingsRestore: [/'settingsRestore'\)\.addEventListener\('click'/, null],
  settingsSearch: [/getElementById\('settingsSearch'\);\n  search\.addEventListener\('input'/, null],
  settingsLookup: [/'settingsLookup'\)\.addEventListener\('click', \(\) => startShortcutLookup\(\)\)/, null],
};
for (const [id, [wired, shown]] of Object.entries(controls)) {
  assert.equal((markup.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `#${id} is in the Settings markup once`);
  assert.match(wire, wired, `#${id} is wired`);
  if (shown) assert.match(sync, shown, `#${id} shows its setting`);
}
assert.match(html, /\$\('#setSnap'\)\.addEventListener\('click', toggleSnapMode\);/, '#setSnap is wired');
assert.match(sync, /\$\$\('setSnap'\)\?\.classList\.toggle\('on', appSettings\.snapEnabled\)/, '#setSnap shows its setting');
assert.match(html, /\$\('#settingsClose'\)\.addEventListener\('click', closeSettings\);/, 'the close button closes Settings');
assert.match(system, /startupTog\.classList\.toggle\('on', !!appSettings\.checkUpdatesOnStartup\)/, '#setCheckOnStartup shows its setting');
assert.equal((markup.match(/class="theme-swatch" data-theme="/g) || []).length, 6, 'six themes');
assert.match(markup, /<img class="s2-logo" id="setAboutIcon" alt="" aria-hidden="true">/, 'About has an icon slot');
assert.match(wire, /getElementById\('setAboutIcon'\)\.src = document\.getElementById\('landingBrandIcon'\)\.src;/, 'About shows the official icon, the one Home shows');
assert.match(wire, /querySelectorAll\('\.theme-swatch'\)\.forEach\(b => b\.addEventListener\('click', \(\) => applyTheme\(b\.dataset\.theme\)\)\)/, 'themes apply on click');

/* Five selects, all upgraded to .ui-select (smoke-landing-layout counts them). */
assert.equal((markup.match(/<select id="/g) || []).length, 5, 'five selects in Settings');

/* Autosave: the interval sits inline and only shows while autosave is on. */
assert.match(markup, /<div class="s2-row s2-row-sub" id="setAutosaveEveryRow">[\s\S]*?<div class="s2-seg" id="setAutosaveEvery"[^>]*>(<button type="button" data-min="(5|10|15|20|30)">\2 min<\/button>){5}<\/div>/, 'the interval choices are inline');
assert.match(sync, /\$\$\('setAutosaveEveryRow'\)\.hidden = !appSettings\.autosave;/, 'shown only while autosave is on');
assert.match(sync, /\$\$\('setLargeMPRow'\)\.hidden = !appSettings\.warnLargeImages;/, 'the size limit shows only while warnings are on');
assert.match(wire, /querySelectorAll\('#setAutosaveEvery button'\)\.forEach\(b => \{\n    b\.addEventListener\('click', \(\) => setAutosaveChoice\(\{ autosaveIntervalMin: parseInt\(b\.dataset\.min, 10\) \}\)\);/, 'picking an interval saves it');
assert.doesNotMatch(html, /autosaveInterval(Modal|Resolve|Seg)/, 'the old interval pop-up is gone');

/* Restore defaults asks first, through the shared confirm dialog. */
assert.match(wire, /'settingsRestore'\)\.addEventListener\('click', async \(\) => \{\n    const ok = await showConfirm\(\{[\s\S]*?\}\);\n    if \(!ok\) return;\n    restoreSettingsDefaults\(\);/, 'Restore defaults confirms before it resets');

/* Search covers every pane and keeps the Snip block's filter across re-renders. */
const search = fn('applySettingsSearch');
assert.match(search, /for \(const pane of modal\.querySelectorAll\('\.s2-pane'\)\)/, 'search walks every pane');
assert.match(search, /pane\.hidden = searching \? !found : pane\.dataset\.pane !== activeSettingsPane\(\);/, 'panes with results show while searching');
assert.match(fn('renderSnipShortcutBlock'), /\n  applySettingsSearch\(\);\n\}\n$/, 'the Snip block keeps a search applied');
assert.match(fn('settingsRowMatches'), /settingsRowCombos\(row\)\.some\(c => keyTerms\.every\(t => c\.includes\(t\)\)\)/, 'key terms match key caps');

/* Hooks other code and tests rely on. */
assert.match(fn('renderShortcutsList'), /block\.id = 's2SnipBlock';\n    block\.className = 's2-sec';\n    pane\.appendChild\(block\);/, 'the Snip block is the first thing in Shortcuts');
assert.match(fn('addSettingsPaneTitle'), /pane\.appendChild\(title\);/, 'pane titles go last, so the Snip block stays first');
assert.match(html, /\.s2-searching \.s2-pane-title\{ order:-1;/, 'and are drawn first by order');
assert.match(html, /\.modal \.settings2-card[\s\S]*?max-width:calc\(100% - 32px\)/, 'Settings fits a split pane');
assert.match(fn('closeSettings'), /stopSnipRecording\(\);\n  stopShortcutLookup\(\);/, 'closing ends any recording');
assert.match(html, /if \(m === settingsModal\) closeSettings\(\);/, 'so does a click on the backdrop');
assert.match(fn('startShortcutLookup'), /window\.addEventListener\('keydown', onShortcutLookupKey, true\);\n  snipShortcutApi\?\.setSnipShortcutRecording\(true\);/, 'Look up a key takes keys ahead of the board and of main');
assert.match(fn('endShortcutLookupRecording'), /window\.removeEventListener\('keydown', onShortcutLookupKey, true\);\n  snipShortcutApi\?\.setSnipShortcutRecording\(false\);/, 'and gives them back');

/* Themed key caps and a short dropdown shadow (the long one read as a smudge). */
const kbd = slice('\nkbd{', '\n}', 'kbd rule');
assert.doesNotMatch(kbd, /#[0-9a-f]{3,6}\b/i, 'key caps use theme colours');
const menu = slice('\n.ui-select-menu{', '\n}', '.ui-select-menu rule');
const shadow = menu.match(/box-shadow:0 (\d+)px (\d+)px rgba\(0,0,0,([\d.]+)\)/);
assert.ok(shadow, 'the menu has a drop shadow');
assert.ok(+shadow[1] <= 10 && +shadow[2] <= 24 && +shadow[3] <= 0.35, `the menu shadow is short and light: ${shadow[0]}`);

console.log(`settings page ok — ${Object.keys(controls).length + 1} controls wired and shown, 5 selects, restore confirms, search covers ${tabs.length} panes`);
