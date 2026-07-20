import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
const preload = fs.readFileSync(new URL('../preload.js', import.meta.url), 'utf8');

assert.match(html, /saveBoardFile\(\{ saveAs: e\.shiftKey \}\)/, 'Ctrl+Shift+S must request Save As while Ctrl+S remains a normal save');
assert.match(html, /Save board as…[\s\S]*?Ctrl\+Shift\+S/, 'the board context menu must expose Save As');
assert.match(html, /label:'Save board as', keys:\['Ctrl','Shift','S'\]/, 'shortcut help must document Save As');
assert.match(html, /beginBoardSave\([\s\S]*?snapshot\.core, null, saveAs/, 'streamed board saving must forward the Save As request without a blocking preview');
assert.match(html, /saveBoardFile\(defaultName, json, currentBoardPath \|\| undefined, saveAs\)/, 'legacy board saving must forward the Save As request');

assert.match(preload, /beginBoardSave: \(defaultName, filePath, core, preview, forceDialog = false\)/, 'the preload bridge must carry streamed Save As intent');
assert.match(preload, /saveBoardFile: \(defaultName, data, filePath, forceDialog = false\)/, 'the preload bridge must carry legacy Save As intent');

assert.equal((main.match(/let target = forceDialog \? null : filePath;/g) || []).length, 2, 'both board save handlers must force a dialog for Save As');
assert.equal((main.match(/defaultPath: filePath \|\| path\.join\(app\.getPath\('documents'\), defaultName\)/g) || []).length, 2, 'Save As must start beside the current board when possible');

console.log('board Save As contract tests passed');
