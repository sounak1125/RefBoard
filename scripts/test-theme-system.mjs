import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const animatics = await readFile(new URL('./animatics.mjs', import.meta.url), 'utf8');

const themes = [
  ['midnight', 'Midnight'],
  ['slate', 'Carbon'],
  ['graphite', 'Ember'],
  ['pine', 'Forest'],
  ['plum', 'Aubergine'],
  ['dim', 'Studio'],
];
const semanticTokens = [
  'bg', 'void', 'workspace', 'card', 'panel', 'surface-1', 'surface-2', 'surface-3',
  'line', 'line-strong', 'txt', 'mut', 'dim', 'acc', 'acc-hover', 'acc-contrast',
  'danger', 'grid-dot', 'scrim', 'shadow',
];

function cssBlock(id) {
  const selector = id === 'midnight' ? ':root' : `[data-theme="${id}"]`;
  const start = html.indexOf(`${selector}{`);
  assert.notEqual(start, -1, `${id} should define a CSS theme block`);
  const end = html.indexOf('}', start);
  return html.slice(start, end + 1);
}

function token(block, name) {
  const match = block.match(new RegExp(`--${name}:\\s*([^;]+);`));
  assert.ok(match, `theme should define --${name}`);
  return match[1].trim();
}

function rgb(hex) {
  const value = hex.replace('#', '');
  assert.match(value, /^[0-9a-f]{6}$/i, `expected a six-digit color, received ${hex}`);
  return [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16));
}

function luminance(hex) {
  const channels = rgb(hex).map(value => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const backgrounds = new Set();
for (const [id, label] of themes) {
  const block = cssBlock(id);
  for (const name of semanticTokens) token(block, name);

  const card = token(block, 'card');
  for (const textToken of ['txt', 'mut', 'dim']) {
    const ratio = contrast(token(block, textToken), card);
    assert.ok(ratio >= 4.5, `${id} --${textToken} contrast is ${ratio.toFixed(2)}:1; expected at least 4.5:1`);
  }
  const buttonRatio = contrast(token(block, 'acc-contrast'), token(block, 'acc'));
  assert.ok(buttonRatio >= 4.5, `${id} accent button contrast is ${buttonRatio.toFixed(2)}:1`);
  backgrounds.add(token(block, 'bg'));

  assert.match(
    html,
    new RegExp(`<button class="theme-swatch" data-theme="${id}"[\\s\\S]*?<strong>${label}</strong>`),
    `${label} should be a visible, selectable theme card`,
  );
}

assert.equal(backgrounds.size, themes.length, 'every theme should have a distinct base background');
assert.match(html, /setAttribute\('aria-pressed',\s*String\(active\)\)/, 'theme cards should expose their selected state');
assert.match(html, /localStorage\.setItem\('refboard\.theme',\s*theme\)/, 'theme choice should persist immediately');
assert.match(animatics, /--an-bg:var\(--bg\)/, 'Animatics should inherit the selected application background');
assert.match(animatics, /--an-accent:var\(--acc\)/, 'Animatics should inherit the selected accent');
assert.match(animatics, /\.an-btn\.primary \{ color:var\(--an-accent-contrast\);[^}]*background:var\(--an-accent\)/, 'Animatics primary actions should use accessible shared theme tokens');
assert.match(animatics, /\.an-top,\.an-side,\.an-timeline,\.an-tl-head \{ background:var\(--an-surface-1\)/, 'Animatics chrome should use shared semantic surfaces');
assert.match(animatics, /\.an-stage-row \{[^}]*background:#0d0f13/, 'the preview workspace should retain its neutral production background');
assert.doesNotMatch(animatics, /\.an-stage(?:-row)?,\.an-empty-stage \{ background:var\(--an-workspace\)/, 'the theme must not flood the preview workspace with accent tint');
assert.doesNotMatch(animatics, /\.an-side-resizer,\.an-timeline-resizer \{ background:/, 'resize hit areas should remain invisible');
assert.match(animatics, /\.an-play \{[^}]*background:#f0f2f7; color:#101217/, 'the central playback control should retain its neutral visual hierarchy');
assert.doesNotMatch(animatics, /\.an-btn\.primary,\.an-play/, 'playback and export actions should not be flattened into one color treatment');

console.log('theme system contract and contrast tests passed');
