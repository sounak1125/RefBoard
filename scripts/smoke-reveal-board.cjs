/* Real landing UI -> preload -> main -> native shell boundary. The shell call
   is recorded so a test run does not open Explorer windows on the desktop. */
const { app, BrowserWindow, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'refboard-reveal-'));
const output = path.join(root, 'stress-out-smoke', 'reveal-board');
fs.mkdirSync(output, { recursive: true });
app.setAppPath(root);
app.setPath('userData', path.join(temp, 'profile'));
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const revealed = [];
const originalReveal = shell.showItemInFolder;
shell.showItemInFolder = filePath => revealed.push(filePath);
app.on('browser-window-created', (_event, window) => {
  window.hide();
  window.webContents.setBackgroundThrottling(false);
});
require('../main.js');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;
const run = expression => win.webContents.executeJavaScript(expression);
async function waitFor(check, label) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await delay(40);
  }
  throw new Error('Timed out: ' + label);
}
async function click(selector) {
  let point;
  await waitFor(async () => {
    point = await run(`(() => {
      const el=document.querySelector(${JSON.stringify(selector)}); if(!el||el.disabled)return null;
      const r=el.getBoundingClientRect(), x=Math.round(r.left+r.width/2), y=Math.round(r.top+r.height/2);
      return r.width>0 && el.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
    })()`);
    return !!point;
  }, 'clickable '+selector);
  win.webContents.sendInputEvent({type:'mouseMove', ...point});
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
  win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
}
async function reveal(selector, expectedPath, keyboard = false) {
  const count = revealed.length;
  if (keyboard) {
    await run(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  } else await click(selector);
  await waitFor(() => revealed.length > count, 'native reveal call');
  await waitFor(() => run(`!document.querySelector(${JSON.stringify(selector)}).disabled`), 'reveal response');
  assert.equal(revealed.length, count + 1, 'one gesture opens one folder');
  assert.equal(revealed.at(-1), expectedPath, 'the exact board file is selected');
  assert.equal(await run('document.body.classList.contains("board-active")'), false, 'folder action must stay on Home');
}
async function layout(name) {
  await run(`window.RefBoard.appSettings.landingLayout=${JSON.stringify(name)}; window.RefBoard.renderRecentWorksForTest()`);
  await delay(400);
}

async function main() {
  let exitCode = 0;
  try {
    await app.whenReady();
    await waitFor(() => (win = BrowserWindow.getAllWindows()[0]), 'app window');
    await waitFor(() => run('!!window.RefBoard?.startupComplete').catch(() => false), 'startup');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
    const boards = ['Moodboard café (v2)', 'Second board'].map(name => ({name, file:path.join(temp, name+'.refboard')}));
    await run(`(async()=>{
      document.querySelectorAll('.modal.show').forEach(el=>el.classList.remove('show'));
      document.querySelector('#whatsNewNotice').classList.add('hide');
      const core={items:[window.RefBoard.makeNoteForTest({x:0,y:0,text:'Board reference'})],view:{tx:0,ty:0,s:1}};
      for(const board of ${JSON.stringify(boards)}){
        const session=await window.RefBoardAPI.beginBoardSave(board.name,board.file,core,null,false);
        if(!session.started)throw new Error('Could not create test board');
        await window.RefBoardAPI.finishBoardSave(session.token);
        await window.RefBoardAPI.addRecentWork({path:board.file,title:board.name,itemCount:1,generateThumbnail:false});
      }
    })()`);
    await layout('classic');
    const classic = '#recentGrid .rw-card:first-child .rw-card-reveal';
    await reveal(classic, boards[1].file);
    await reveal(classic, boards[1].file, true);

    await layout('focus');
    const focus = '#focusTrack .ff-card.is-active .rw-card-reveal';
    await reveal(focus, boards[1].file);
    await reveal(focus, boards[1].file, true);
    assert.ok(await run(`[...document.querySelectorAll('.ff-card:not(.is-active) .rw-card-reveal')].every(b=>b.tabIndex===-1&&getComputedStyle(b).opacity==='0')`));
    for (const [width,height] of [[1360,860],[720,480]]) {
      win.setContentSize(width,height);
      await delay(500);
      assert.ok(await run(`(() => {
        const card=document.querySelector('.ff-card.is-active').getBoundingClientRect();
        const buttons=[...document.querySelectorAll('.ff-card.is-active > button')].map(b=>b.getBoundingClientRect());
        return buttons.every(r=>r.left>=card.left&&r.right<=card.right&&r.top>=card.top)
          && buttons.every((r,i)=>buttons.slice(i+1).every(s=>r.right<=s.left||s.right<=r.left));
      })()`), 'card actions must fit without overlapping at '+width+'x'+height);
      await run('document.activeElement?.blur()');
      fs.writeFileSync(path.join(output, width+'x'+height+'.png'), (await win.webContents.capturePage()).toPNG());
    }

    // A completed rename must reveal the new file, not its former location.
    await run('document.querySelector(".ff-card.is-active .rw-card-rename").click()');
    await waitFor(() => run('!!document.querySelector(".ff-card.is-active .rw-rename-input")'), 'rename input');
    assert.equal(await run(`getComputedStyle(document.querySelector(${JSON.stringify(focus)})).display`),'none');
    await run(`document.querySelector('.ff-card.is-active .rw-rename-input').value='Renamed board'; document.querySelector('.rw-rename-confirm').click()`);
    await waitFor(() => run('document.querySelector(".ff-card.is-active .rw-title")?.textContent === "Renamed board"'), 'rename completion');
    const renamed = path.join(temp, 'Renamed board.refboard');
    await reveal(focus, renamed);

    // The current board also has a location once it has been saved.
    await run(`window.RefBoard.openBoardFromPath(${JSON.stringify(boards[0].file)})`);
    await waitFor(() => run('document.body.classList.contains("board-active")'), 'opened board');
    assert.equal(await run('getComputedStyle(document.querySelector("#recentWorks")).display'),'none');
    await run('document.querySelector("#sidebarHome").click()');
    await waitFor(() => run('!document.body.classList.contains("board-active") && !!document.querySelector(".ff-card-current .rw-card-reveal")'), 'saved current board');
    await reveal('.ff-card-current .rw-card-reveal', boards[0].file);
    await layout('classic');
    await reveal('.rw-card-current .rw-card-reveal', boards[0].file, true);

    // Missing files and malformed inputs never open an unrelated folder.
    const calls = revealed.length;
    fs.unlinkSync(boards[0].file);
    await click('.rw-card-current .rw-card-reveal');
    await waitFor(() => run('document.querySelector("#toast").textContent.includes("moved or was deleted")'), 'missing file message');
    const directory = path.join(temp,'directory.refboard');
    fs.mkdirSync(directory);
    for(const invalid of [null, {}, '', 'relative.refboard', 'https://example.com/a.refboard', path.join(temp,'a.txt'), directory]) {
      const result=await run(`window.RefBoardAPI.revealBoardFile(${JSON.stringify(invalid)})`);
      assert.equal(result.ok,false);
    }
    assert.equal(revealed.length,calls);

    // A fresh unsaved current board has no folder action in either layout.
    await run('document.querySelector("#rwNewBoard").click()');
    await waitFor(() => run('document.body.classList.contains("board-active")'), 'new board');
    await run('window.RefBoard.state.items.push(window.RefBoard.makeNoteForTest({x:0,y:0,text:"Unsaved"})); document.querySelector("#sidebarHome").click()');
    await waitFor(() => run('!document.body.classList.contains("board-active")'), 'unsaved Home');
    for (const name of ['classic','focus']) {
      await layout(name);
      const selector=name==='classic'?'.rw-card-current':'.ff-card-current';
      assert.ok(await run(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector+' .rw-card-reveal')})`));
    }
    console.log('Show in folder Electron smoke passed: both layouts, mouse/keyboard, exact shell path, renamed/current/unsaved/missing boards, compact controls.');
  } catch (error) {
    console.error(error);
    exitCode = 1;
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());
  } finally {
    shell.showItemInFolder = originalReveal;
    app.removeAllListeners('window-all-closed');
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    const { removeProfileDir } = await import('./smoke-profile-cleanup.mjs');
    await removeProfileDir(temp);
    app.exit(exitCode);
  }
}
void main();
