import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');

assert.match(
  source,
  /const SETTINGS_DEFAULTS\s*=\s*\{[\s\S]*?landingLayout:\s*['"]classic['"]/,
  'Classic Grid should remain the safe default for existing users',
);
assert.match(
  source,
  /function normalizeLandingLayout\(v\)\s*\{[\s\S]*?v === ['"]focus['"] \? ['"]focus['"] : ['"]classic['"]/,
  'unknown stored home layouts should fall back to Classic Grid',
);
assert.match(
  source,
  /<select id="setLandingLayout">[\s\S]*?value="classic">Classic Grid[\s\S]*?value="focus">Focus Flow/,
  'Appearance settings should expose both named home layouts',
);
assert.doesNotMatch(source, /id="rwSettings"|\$\('#rwSettings'\)/, 'Home should not expose a separate Settings entry');
assert.match(
  source,
  /async function renderRecentWorks\(\)[\s\S]*?focusLayout[\s\S]*?renderFocusRecentWorks\(list, renderSeq\)[\s\S]*?renderClassicRecentWorks\(list, renderSeq\)/,
  'both layouts should render from the same recent-board source',
);
assert.match(
  source,
  /focusFlowEntries\s*=\s*\[current, \.\.\.recent\.map\(recentFocusEntry\)\]\.filter\(Boolean\)/,
  'the in-memory current board should be the first Focus Flow card',
);
assert.match(
  source,
  /list\.filter\(work => !sameFilePath\(work\.path, current\.path\)\)/,
  'Focus Flow should not duplicate the current board in the recent cards',
);
assert.match(
  source,
  /stage\.addEventListener\('keydown'[\s\S]*?e\.key === 'ArrowRight'/,
  'Focus Flow should support keyboard navigation',
);
assert.match(
  source,
  /stage\.addEventListener\('wheel'[\s\S]*?stage\.addEventListener\('pointerdown'/,
  'Focus Flow should support wheel and drag navigation',
);
assert.match(
  source,
  /function focusFlowVisibleRadius\(\)[\s\S]*?innerWidth >= 1800[\s\S]*?return 3;[\s\S]*?innerWidth >= 980[\s\S]*?return 2;[\s\S]*?return 1;/,
  'card visibility should adapt to seven, five, or three staged cards',
);
assert.match(
  source,
  /const visible = distance <= visibleRadius[\s\S]*?card\.style\.visibility = visible \? 'visible' : 'hidden'/,
  'cards outside the responsive visual window should be completely hidden',
);
assert.doesNotMatch(source, /--ff-blur|filter:\s*blur\(var\(--ff/, 'card hierarchy should never blur thumbnails or metadata');
assert.doesNotMatch(source, /ff-orb|ffAmbient|ff-parallax/, 'the landing background should not use moving colored blobs or parallax');
assert.match(
  source,
  /async function captureBoardThumbnailBase64\(maxPx = 1440\)[\s\S]*?toBlob\(r, 'image\/jpeg', 0\.94\)/,
  'new recent-board thumbnails should be generated at premium resolution and quality',
);
assert.match(
  source,
  /thumbSrcForWork\(entry\.work, \{ preferBoardPreview: true \}\)/,
  'Focus Flow should prefer the higher-resolution preview embedded in the board file',
);
assert.match(
  source,
  /\.ff-card \.rw-thumb img\{ object-fit:contain; \}/,
  'Focus Flow should preserve wide board previews instead of enlarging and cropping them',
);
assert.match(
  source,
  /card\.addEventListener\('click',[\s\S]*?if \(focusFlowSuppressClick\) return;[\s\S]*?openFocusEntry\(entry\);/,
  'clicking any visible Focus Flow card should open it directly',
);
assert.match(
  source,
  /if \(Math\.abs\(dx\) <= 10\) return;[\s\S]*?focusFlowDrag\.moved = true;[\s\S]*?stage\.setPointerCapture\(e\.pointerId\)/,
  'the carousel must not capture the pointer until a real drag has started',
);
assert.doesNotMatch(source, /ff-open-label/, 'Focus Flow cards should not show a redundant Open control');
assert.match(
  source,
  /body\.board-active #recentWorks\{ display:none; \}/,
  'board mode should structurally remove the complete landing layer',
);
assert.match(
  source,
  /async function transitionToBoard[\s\S]*?recent\.classList\.add\('landing-hidden'\);[\s\S]*?document\.body\.classList\.add\('board-active'\);/,
  'the landing layer should be hidden before board mode is exposed',
);
assert.match(
  source,
  /function setupSettingsSelects\(\)[\s\S]*?ui-select-button[\s\S]*?ui-select-menu[\s\S]*?role = 'listbox'/,
  'Settings selects should be upgraded to the custom RefBoard dropdown UI',
);
assert.match(
  source,
  /\.ui-select-menu\.show\{[^}]*display:flex/,
  'custom dropdowns should provide a styled open state',
);
assert.match(
  source,
  /\.ui-select-option\[aria-selected="true"\]\{/,
  'custom dropdowns should provide a selected option state',
);
assert.match(
  source,
  /async function transitionToLanding\(\)[\s\S]*?focusFlowEntries = \[\];[\s\S]*?focusFlowIndex = 0;[\s\S]*?renderRecentWorks\(\)/,
  'returning Home should always start with the latest/current board centered',
);
assert.match(
  source,
  /if \(onLanding\) \{[\s\S]*?k === 'o'[\s\S]*?openBoardFromDialog\(\)[\s\S]*?return;/,
  'landing keyboard handling should retain Open board access',
);

console.log('landing layout contract tests passed');
