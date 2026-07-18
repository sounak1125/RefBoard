import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');

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
  'sidebarHome', 'btnAdd', 'btnSelectTool', 'btnHandTool', 'btnDraw', 'btnPaste', 'btnNote',
  'btnArrange', 'btnFit', 'btnAnimatics', 'btnExport', 'btnSave', 'btnOpen', 'btnClear',
];
for (const id of buttons) {
  assert.match(source, new RegExp(`id=["']${id}["']`), `${id} should remain in the toolbar`);
  assert.match(source, new RegExp(`\\$\\(['"]#${id}['"]\\)\\.addEventListener\\('click'`), `${id} should retain its click handler`);
}

console.log('toolbar mode contract tests passed');
