import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (await readFile(new URL('../index.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

assert.match(source, /toolbarMode:\s*['"]floating['"]/, 'Floating Compact should be the default toolbar mode');
assert.match(
  source,
  /function normalizeToolbarMode\(v\)\s*\{[\s\S]*?v === ['"]pinned['"] \? ['"]pinned['"] : ['"]floating['"]/,
  'unknown toolbar settings should safely use Floating Compact',
);
assert.match(
  source,
  /<select id="setToolbarMode">[\s\S]*?value="floating">Floating Compact[\s\S]*?value="pinned">Always Visible/,
  'Appearance settings should expose floating and classic pinned modes',
);
assert.match(source, /id="toolbarEdgeHandle"[\s\S]*?aria-controls="toolbar"[\s\S]*?aria-expanded="false"/, 'the edge handle should be an accessible toolbar control');
assert.match(source, /body\.toolbar-floating #toolbar \.tb\{ width:30px; height:34px;/, 'the floating rail should keep compact width while matching the classic button height');
assert.match(source, /body\.board-active\.toolbar-floating #toolbar\{[\s\S]*?opacity:0; pointer-events:none;/, 'the compact rail should remain collapsed until revealed');
assert.match(source, /body\.board-active\.toolbar-floating #toolbarEdgeHandle\{ display:flex; \}/, 'the edge handle should only appear for floating board mode');
assert.match(source, /#toolbarEdgeHandle\{[\s\S]*?border-radius:0 18px 18px 0;/, 'the hidden tab should be a quiet rounded edge tab');
assert.doesNotMatch(source, /toolbar-edge-chevron/, 'the hidden tab should show the active tool without a chevron');
assert.doesNotMatch(source, /#toolbarEdgeHandle::before/, 'the hidden tab should not paint an accent stripe');
assert.match(source, /function revealToolbar\(\)[\s\S]*?setToolbarRevealed\(true\)/, 'the edge interaction should reveal the floating rail');
assert.match(source, /if \(e\.clientX <= 10\) revealToolbar\(\)/, 'moving into the left-edge zone should reveal the toolbar');
assert.match(source, /function toolbarShouldStayOpen\(\)[\s\S]*?drawFeaturesOpen \|\| addFeaturesOpen \|\| brushDrawerOpen/, 'open tool drawers should keep the floating rail visible');
assert.match(source, /--toolbar-drawer-left[\s\S]*?syncToolbarDrawerOffset/, 'tool drawers should follow the live toolbar position');
assert.match(
  source,
  /toolbarModeSel\.addEventListener\('change',[\s\S]*?saveAppSettings\(\);[\s\S]*?applyToolbarMode\(\);/,
  'changing toolbar mode should persist and apply immediately',
);

const buttons = [
  'sidebarHome', 'btnAdd', 'btnSelectTool', 'btnHandTool', 'btnDraw', 'btnNote',
  'btnArrange', 'btnSearch', 'btnExport', 'btnClear',
];
for (const id of buttons) {
  assert.match(source, new RegExp(`id=["']${id}["']`), `${id} should remain in the toolbar`);
  assert.match(source, new RegExp(`\\$\\(['"]#${id}['"]\\)\\.addEventListener\\('click'`), `${id} should retain its click handler`);
}

// Paste, Save, Open and Fit left the toolbar; each must still have a shortcut,
// a right-click entry and a line in the ? help.
const removed = {
  btnPaste: {
    key: /window\.addEventListener\('paste', async e => \{/,
    menu: /\{ l: 'Paste', k: 'Ctrl\+V', f: \(\) => menuPaste\(pos\) \}/,
    help: /\{ cat:'Editing', label:'Paste', keys:\['Ctrl','V'\] \}/,
  },
  btnSave: {
    key: /else if \(mod && k === 's'\) \{ e\.preventDefault\(\); manualSaveBoardFile\(\(\) => saveBoardFile\(/,
    menu: /\{ l: 'Save board file', k: 'Ctrl\+S', f: \(\) => manualSaveBoardFile\(\(\) => saveBoardFile\(\)\) \}/,
    help: /\{ cat:'Files', label:'Save board', keys:\['Ctrl','S'\] \}/,
  },
  btnOpen: {
    key: /else if \(mod && k === 'o'\) \{ e\.preventDefault\(\); openBoardFromDialog\(\); \}/,
    menu: /\{ l: 'Open board file', k: 'Ctrl\+O', f: \(\) => openBoardFromDialog\(\) \}/,
    help: /\{ cat:'Files', label:'Open board', keys:\['Ctrl','O'\] \}/,
  },
  btnFit: {
    key: /else if \(k === 'f'\) fitTo\(/,
    menu: /\{ l: 'Fit view', k: 'F', f: \(\) => fitTo\(/,
    help: /\{ cat:'View', label:'Fit view', keys:\['F'\](, note:'[^']*')? \}/,
  },
};
for (const [id, paths] of Object.entries(removed)) {
  assert.doesNotMatch(source, new RegExp(`id=["']${id}["']`), `${id} should no longer be in the toolbar`);
  assert.doesNotMatch(source, new RegExp(`#${id}\\b`), `nothing should still look up #${id}`);
  for (const [via, re] of Object.entries(paths)) assert.match(source, re, `${id}'s action should stay reachable by ${via}`);
}

console.log('toolbar mode contract tests passed');
