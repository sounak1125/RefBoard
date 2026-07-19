'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refboard-landing-smoke-'));
const screenshotPath = process.env.REFBOARD_SMOKE_SCREENSHOT || path.join(tempRoot, 'focus-flow.png');
const screenshotExt = path.extname(screenshotPath) || '.png';
const settingsScreenshotPath = screenshotPath.slice(0, screenshotPath.length - screenshotExt.length) + '-settings' + screenshotExt;
const toolbarScreenshotPath = screenshotPath.slice(0, screenshotPath.length - screenshotExt.length) + '-toolbar' + screenshotExt;
app.setPath('userData', path.join(tempRoot, 'user-data'));
app.commandLine.appendSwitch('disable-gpu');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(win, expression, label, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    } catch { /* renderer may still be reloading */ }
    await delay(80);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function clickElement(win, selector) {
  const point = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  })()`);
  if (!point) throw new Error(`Missing click target: ${selector}`);
  point.hitBefore = await win.webContents.executeJavaScript(`document.elementFromPoint(${point.x}, ${point.y})?.closest('button')?.id || document.elementFromPoint(${point.x}, ${point.y})?.id || null`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await delay(40);
  point.hitAfter = await win.webContents.executeJavaScript(`document.elementFromPoint(${point.x}, ${point.y})?.closest('button')?.id || document.elementFromPoint(${point.x}, ${point.y})?.id || null`);
  return point;
}

async function revealToolbarForSmoke(win) {
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 450 });
  await waitFor(win, "document.body.classList.contains('toolbar-revealed')", 'toolbar reveal');
  await delay(240);
}

async function run() {
  const rendererErrors = [];
  let smokeStep = 'create window';
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#101116',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', details => {
    const text = details?.message || '';
    if (/Uncaught|SyntaxError|ReferenceError|TypeError/i.test(text || '')) rendererErrors.push(text);
  });

  try {
  smokeStep = 'initial load';
  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await waitFor(win, "document.querySelector('#recentWorks')", 'initial renderer');
  smokeStep = 'seed local storage';
  await win.webContents.executeJavaScript(`
    localStorage.setItem('refboard.settings', JSON.stringify({ landingLayout: 'focus' }));
    localStorage.setItem('refboard.recentWorks', JSON.stringify(Array.from({ length: 9 }, (_, index) => ({
      path: 'C:/Smoke/Board-' + (index + 1) + '.refboard',
      title: index === 0 ? 'Latest concepts' : 'Board ' + (index + 1),
      itemCount: 18 - index,
      lastOpened: Date.now() - index * 60000,
      lastEdited: Date.now() - index * 60000
    }))));
  `);
  smokeStep = 'reload Focus Flow';
  win.webContents.reloadIgnoringCache();
  await waitFor(win, "document.querySelectorAll('#focusTrack .ff-card').length === 9", 'Focus Flow cards');

  const focusState = await win.webContents.executeJavaScript(`({
    focusClass: document.querySelector('#recentWorks').classList.contains('layout-focus'),
    flowVisible: !document.querySelector('#focusFlow').hidden,
    gridHidden: document.querySelector('#recentGrid').hidden,
    activeTitle: document.querySelector('.ff-card.is-active .rw-title')?.textContent,
    cardCount: document.querySelectorAll('#focusTrack .ff-card').length,
    visiblePolicy: document.querySelector('#focusStage').dataset.visibleCards,
    settingValue: document.querySelector('#setLandingLayout').value,
    landingSettingsPresent: Boolean(document.querySelector('#rwSettings')),
    customSelectCount: document.querySelectorAll('.settings2-content .ui-select').length,
    exportCustomSelectCount: document.querySelectorAll('#exportImagesModal .ui-select').length
  })`);
  if (!focusState.focusClass || !focusState.flowVisible || !focusState.gridHidden
      || focusState.activeTitle !== 'Latest concepts' || focusState.cardCount !== 9
      || focusState.visiblePolicy !== '5' || focusState.settingValue !== 'focus'
      || focusState.landingSettingsPresent || focusState.customSelectCount !== 4
      || focusState.exportCustomSelectCount !== 3) {
    throw new Error(`Unexpected Focus Flow state: ${JSON.stringify(focusState)}`);
  }

  smokeStep = 'adaptive card hierarchy';
  await win.webContents.executeJavaScript("(() => { for (let i = 0; i < 4; i++) document.querySelector('#focusNext').click(); })()");
  const desktopHierarchy = await win.webContents.executeJavaScript(`({
    activeTitle: document.querySelector('.ff-card.is-active .rw-title')?.textContent,
    visible: [...document.querySelectorAll('.ff-card')].filter(card => card.style.visibility !== 'hidden').length,
    policy: document.querySelector('#focusStage').dataset.visibleCards,
    hasBlur: [...document.querySelectorAll('.ff-card')].some(card => getComputedStyle(card).filter.includes('blur'))
  })`);
  if (desktopHierarchy.activeTitle !== 'Board 5' || desktopHierarchy.visible !== 5
      || desktopHierarchy.policy !== '5' || desktopHierarchy.hasBlur) {
    throw new Error(`Unexpected desktop hierarchy: ${JSON.stringify(desktopHierarchy)}`);
  }

  await win.webContents.executeJavaScript("Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2000 }); window.dispatchEvent(new Event('resize'))");
  await delay(80);
  const wideHierarchy = await win.webContents.executeJavaScript(`({
    visible: [...document.querySelectorAll('.ff-card')].filter(card => card.style.visibility !== 'hidden').length,
    policy: document.querySelector('#focusStage').dataset.visibleCards
  })`);
  if (wideHierarchy.visible !== 7 || wideHierarchy.policy !== '7') {
    throw new Error(`Unexpected ultrawide hierarchy: ${JSON.stringify(wideHierarchy)}`);
  }

  await win.webContents.executeJavaScript("Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 }); window.dispatchEvent(new Event('resize'))");
  await delay(80);
  const compactHierarchy = await win.webContents.executeJavaScript(`({
    visible: [...document.querySelectorAll('.ff-card')].filter(card => card.style.visibility !== 'hidden').length,
    policy: document.querySelector('#focusStage').dataset.visibleCards
  })`);
  if (compactHierarchy.visible !== 3 || compactHierarchy.policy !== '3') {
    throw new Error(`Unexpected compact hierarchy: ${JSON.stringify(compactHierarchy)}`);
  }
  await win.webContents.executeJavaScript("Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 }); window.dispatchEvent(new Event('resize'))");
  await delay(80);

  smokeStep = 'custom Settings dropdown';
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('#recentWorks').style.display = 'none';
      document.querySelector('#settingsModal').classList.add('show');
      document.querySelector('.s2-tab[data-pane="appearance"]').click();
      document.querySelector('#setLandingLayout').closest('.ui-select').querySelector('.ui-select-button').click();
    })();
  `);
  const dropdownOpen = await win.webContents.executeJavaScript("document.querySelector('#uiSelectMenu-setLandingLayout').classList.contains('show')");
  if (!dropdownOpen) throw new Error('Custom Home layout dropdown did not open');
  await delay(150);
  const settingsPng = await win.webContents.capturePage();
  fs.writeFileSync(settingsScreenshotPath, settingsPng.toPNG());
  await win.webContents.executeJavaScript("document.querySelector('#uiSelectMenu-setLandingLayout [data-value=\"classic\"]').click()");
  await waitFor(win, "document.querySelectorAll('#recentGrid .rw-card').length === 9", 'Classic Grid cards');
  const classicState = await win.webContents.executeJavaScript(`({
    focusClass: document.querySelector('#recentWorks').classList.contains('layout-focus'),
    flowHidden: document.querySelector('#focusFlow').hidden,
    gridHidden: document.querySelector('#recentGrid').hidden,
    savedLayout: JSON.parse(localStorage.getItem('refboard.settings')).landingLayout,
    buttonLabel: document.querySelector('#setLandingLayout').closest('.ui-select').querySelector('.ui-select-button-label').textContent,
    selectedOption: document.querySelector('#uiSelectMenu-setLandingLayout [aria-selected="true"]')?.dataset.value
  })`);
  if (classicState.focusClass || !classicState.flowHidden || classicState.gridHidden
      || classicState.savedLayout !== 'classic' || classicState.buttonLabel !== 'Classic Grid'
      || classicState.selectedOption !== 'classic') {
    throw new Error(`Unexpected Classic Grid state: ${JSON.stringify(classicState)}`);
  }

  smokeStep = 'Settings label clipping';
  const clippingState = await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('.s2-tab[data-pane="general"]').click();
      const select = document.querySelector('#setRenderQuality');
      select.value = 'high';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const button = select.closest('.ui-select').querySelector('.ui-select-button');
      const label = button.querySelector('.ui-select-button-label');
      const buttonRect = button.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      document.querySelector('.s2-tab[data-pane="appearance"]').click();
      return {
        text: label.textContent,
        lineHeight: parseFloat(getComputedStyle(button).lineHeight),
        scrollFits: label.scrollHeight <= label.clientHeight + 1,
        boundsFit: labelRect.top >= buttonRect.top - 1 && labelRect.bottom <= buttonRect.bottom + 1
      };
    })()
  `);
  if (clippingState.text !== 'High' || clippingState.lineHeight < 15
      || !clippingState.scrollFits || !clippingState.boundsFit) {
    throw new Error(`Settings dropdown label is clipped: ${JSON.stringify(clippingState)}`);
  }

  smokeStep = 'restore Focus Flow';
  await win.webContents.executeJavaScript(`
    (() => {
      const root = document.querySelector('#setLandingLayout').closest('.ui-select');
      root.querySelector('.ui-select-button').click();
      document.querySelector('#uiSelectMenu-setLandingLayout [data-value="focus"]').click();
      document.querySelector('#settingsModal').classList.remove('show');
      document.querySelector('#recentWorks').style.display = '';
    })();
  `);
  await waitFor(win, "!document.querySelector('#focusFlow').hidden && document.querySelector('.ff-card.is-active .rw-title')?.textContent === 'Latest concepts'", 'restored Focus Flow cards');
  await delay(500);
  const png = await win.webContents.capturePage();
  fs.writeFileSync(screenshotPath, png.toPNG());

  smokeStep = 'direct card open interaction';
  const cardClickPoint = await win.webContents.executeJavaScript(`
    (() => {
      window.RefBoardAPI = {
        readBoardFile: async filePath => ({
          filePath,
          data: JSON.stringify({
            app: 'refboard', version: 3,
            view: { tx: 0, ty: 0, s: 1 },
            boardGray: false, snapEnabled: false, gridAppearance: 'dots',
            items: [], images: []
          })
        })
      };
      const card = document.querySelector('#focusCard1');
      const rect = card.getBoundingClientRect();
      for (let x = Math.min(innerWidth - 6, rect.right - 6); x >= rect.left + 6; x -= 6) {
        for (let y = rect.top + rect.height * .35; y <= rect.top + rect.height * .72; y += 12) {
          if (document.elementFromPoint(x, y)?.closest('.ff-card') === card) return { x: Math.round(x), y: Math.round(y) };
        }
      }
      return null;
    })()
  `);
  if (!cardClickPoint) throw new Error('Could not find an exposed mouse target on the side card');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: cardClickPoint.x, y: cardClickPoint.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: cardClickPoint.x, y: cardClickPoint.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: cardClickPoint.x, y: cardClickPoint.y, button: 'left', clickCount: 1 });
  await waitFor(win, "document.body.classList.contains('board-active') && getComputedStyle(document.querySelector('#recentWorks')).display === 'none'", 'one-click board open with hidden landing layer');
  const directCardOpen = await win.webContents.executeJavaScript(`({
    boardActive: document.body.classList.contains('board-active'),
    landingHidden: document.querySelector('#recentWorks').classList.contains('landing-hidden'),
    landingDisplay: getComputedStyle(document.querySelector('#recentWorks')).display,
    visibleFocusCards: [...document.querySelectorAll('.ff-card')].filter(card => {
      const style = getComputedStyle(card);
      return card.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }).length,
    hasOpenLabel: Boolean(document.querySelector('.ff-open-label'))
  })`);
  if (!directCardOpen.boardActive || !directCardOpen.landingHidden || directCardOpen.landingDisplay !== 'none'
      || directCardOpen.visibleFocusCards !== 0
      || directCardOpen.hasOpenLabel) {
    throw new Error(`Unexpected direct card-open behavior: ${JSON.stringify(directCardOpen)}`);
  }
  await waitFor(win, "!document.querySelector('#openingOverlay').classList.contains('show')", 'completed board-open overlay');

  smokeStep = 'floating toolbar reveal and buttons';
  const floatingInitial = await win.webContents.executeJavaScript(`({
    floating: document.body.classList.contains('toolbar-floating'),
    revealed: document.body.classList.contains('toolbar-revealed'),
    handleDisplay: getComputedStyle(document.querySelector('#toolbarEdgeHandle')).display,
    toolbarOpacity: getComputedStyle(document.querySelector('#toolbar')).opacity,
    buttonCount: document.querySelectorAll('#toolbar > .tb').length
  })`);
  if (!floatingInitial.floating || floatingInitial.revealed || floatingInitial.handleDisplay !== 'flex'
      || floatingInitial.toolbarOpacity !== '0' || floatingInitial.buttonCount !== 14) {
    throw new Error(`Unexpected initial floating toolbar: ${JSON.stringify(floatingInitial)}`);
  }
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 450 });
  await waitFor(win, "document.body.classList.contains('toolbar-revealed') && Number(getComputedStyle(document.querySelector('#toolbar')).opacity) > .9", 'left-edge toolbar reveal');
  await delay(260);
  const toolbarPng = await win.webContents.capturePage();
  fs.writeFileSync(toolbarScreenshotPath, toolbarPng.toPNG());
  const handClick = await clickElement(win, '#btnHandTool');
  const handState = await win.webContents.executeJavaScript(`({
    handOn: document.querySelector('#btnHandTool').classList.contains('on'),
    selectOn: document.querySelector('#btnSelectTool').classList.contains('on'),
    handleLabel: document.querySelector('#toolbarEdgeHandle').getAttribute('aria-label'),
    toolbarPointerEvents: getComputedStyle(document.querySelector('#toolbar')).pointerEvents,
    toolbarRect: document.querySelector('#toolbar').getBoundingClientRect().toJSON()
  })`);
  if (!handState.handOn || !handState.handleLabel.includes('Hand active')) {
    throw new Error(`Hand button did not activate: ${JSON.stringify({ handClick, handState })}`);
  }
  await clickElement(win, '#btnSelectTool');
  await waitFor(win, "document.querySelector('#btnSelectTool').classList.contains('on') && document.querySelector('#toolbarEdgeHandle').getAttribute('aria-label').includes('Select active')", 'Select toolbar button');
  await clickElement(win, '#btnAdd');
  await waitFor(win, "document.querySelector('#addPanelWrap').classList.contains('open') && document.body.classList.contains('toolbar-revealed')", 'Add toolbar drawer');
  const addDrawerOffset = await win.webContents.executeJavaScript(`(() => {
    const toolbar = document.querySelector('#toolbar').getBoundingClientRect();
    const drawer = document.querySelector('#addPanelWrap').getBoundingClientRect();
    return Math.abs(drawer.left - (toolbar.right + 8));
  })()`);
  if (addDrawerOffset > 2) throw new Error(`Add drawer is detached from compact toolbar by ${addDrawerOffset}px`);
  await clickElement(win, '#btnAdd');
  await waitFor(win, "!document.querySelector('#addPanelWrap').classList.contains('open')", 'Add toolbar drawer close');
  await clickElement(win, '#btnDraw');
  await waitFor(win, "document.querySelector('#drawPanelWrap').classList.contains('open') && document.body.classList.contains('toolbar-revealed')", 'Draw toolbar drawer');
  await clickElement(win, '#btnDraw');
  await waitFor(win, "!document.querySelector('#drawPanelWrap').classList.contains('open')", 'Draw toolbar drawer close');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 720, y: 450 });
  await waitFor(win, "!document.body.classList.contains('toolbar-revealed')", 'floating toolbar auto-hide', 2500);

  smokeStep = 'toolbar mode Settings persistence';
  await win.webContents.executeJavaScript(`
    (() => {
      document.querySelector('#settingsModal').classList.add('show');
      document.querySelector('.s2-tab[data-pane="appearance"]').click();
      const root = document.querySelector('#setToolbarMode').closest('.ui-select');
      root.querySelector('.ui-select-button').click();
      document.querySelector('#uiSelectMenu-setToolbarMode [data-value="pinned"]').click();
    })()
  `);
  await waitFor(win, "document.body.classList.contains('toolbar-pinned') && JSON.parse(localStorage.getItem('refboard.settings')).toolbarMode === 'pinned'", 'Always Visible setting');
  const pinnedToolbar = await win.webContents.executeJavaScript(`({
    mode: document.querySelector('#setToolbarMode').value,
    buttonLabel: document.querySelector('#setToolbarMode').closest('.ui-select').querySelector('.ui-select-button-label').textContent,
    handleDisplay: getComputedStyle(document.querySelector('#toolbarEdgeHandle')).display,
    toolbarOpacity: getComputedStyle(document.querySelector('#toolbar')).opacity,
    toolbarPointerEvents: getComputedStyle(document.querySelector('#toolbar')).pointerEvents,
    toolbarHeight: document.querySelector('#toolbar').getBoundingClientRect().height
  })`);
  if (pinnedToolbar.mode !== 'pinned' || pinnedToolbar.buttonLabel !== 'Always Visible'
      || pinnedToolbar.handleDisplay !== 'none' || pinnedToolbar.toolbarOpacity !== '1'
      || pinnedToolbar.toolbarPointerEvents !== 'auto') {
    throw new Error(`Unexpected pinned toolbar state: ${JSON.stringify(pinnedToolbar)}`);
  }
  const toolbarHeights = {
    floating: handState.toolbarRect.height,
    pinned: pinnedToolbar.toolbarHeight,
    difference: Math.abs(handState.toolbarRect.height - pinnedToolbar.toolbarHeight)
  };
  if (toolbarHeights.difference > 0.5) {
    throw new Error(`Floating and pinned toolbar heights do not match: ${JSON.stringify(toolbarHeights)}`);
  }
  await win.webContents.executeJavaScript(`
    (() => {
      const root = document.querySelector('#setToolbarMode').closest('.ui-select');
      root.querySelector('.ui-select-button').click();
      document.querySelector('#uiSelectMenu-setToolbarMode [data-value="floating"]').click();
      document.querySelector('#settingsModal').classList.remove('show');
    })()
  `);
  await waitFor(win, "document.body.classList.contains('toolbar-floating') && JSON.parse(localStorage.getItem('refboard.settings')).toolbarMode === 'floating'", 'Floating Compact setting restore');
  const toolbarModes = await win.webContents.executeJavaScript(`({
    savedMode: JSON.parse(localStorage.getItem('refboard.settings')).toolbarMode,
    floating: document.body.classList.contains('toolbar-floating'),
    pinnedTest: true
  })`);

  smokeStep = 'remaining toolbar button actions';
  await win.webContents.executeJavaScript(`(() => {
    Object.assign(window.RefBoardAPI, {
      readClipboardNotes: async () => null,
      readClipboardImage: async () => null,
      saveBoardFile: async () => ({ saved: false }),
      openBoardDialog: async () => null
    });
    return true;
  })()`);
  await revealToolbarForSmoke(win);
  await clickElement(win, '#btnPaste');
  await clickElement(win, '#btnNote');
  await waitFor(win, "window.RefBoard.state.items.some(item => item.kind === 'note')", 'Note toolbar button');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
  await delay(80);
  await revealToolbarForSmoke(win);
  await clickElement(win, '#btnArrange');
  await clickElement(win, '#btnFit');
  await clickElement(win, '#btnAnimatics');
  await delay(100);
  await win.webContents.executeJavaScript(`(() => { window.RefBoard.animatics?.close?.(); return true; })()`);
  await revealToolbarForSmoke(win);
  await clickElement(win, '#btnExport');
  await waitFor(win, "document.querySelector('#exportModal').classList.contains('show')", 'Export toolbar button');
  await clickElement(win, '#expCancel');
  await revealToolbarForSmoke(win);
  await clickElement(win, '#btnSave');
  await delay(100);
  await revealToolbarForSmoke(win);
  await clickElement(win, '#btnOpen');
  await delay(80);
  await revealToolbarForSmoke(win);
  await clickElement(win, '#btnClear');
  await waitFor(win, "document.querySelector('#confirmModal').classList.contains('show')", 'Clear toolbar button');
  await clickElement(win, '#confirmCancel');
  await revealToolbarForSmoke(win);
  await clickElement(win, '#sidebarHome');
  await waitFor(win, "document.querySelector('#unsavedModal').classList.contains('show')", 'Home toolbar button');
  await clickElement(win, '#unsavedDiscard');
  await waitFor(win, "!document.body.classList.contains('board-active') && getComputedStyle(document.querySelector('#recentWorks')).display !== 'none'", 'Home navigation from toolbar');
  const allToolbarButtons = await win.webContents.executeJavaScript(`({
    total: document.querySelectorAll('#toolbar > .tb').length,
    homeReached: !document.body.classList.contains('board-active'),
    rendererHasNote: window.RefBoard.state.items.some(item => item.kind === 'note')
  })`);
  if (allToolbarButtons.total !== 14 || !allToolbarButtons.homeReached) {
    throw new Error(`Unexpected all-button smoke state: ${JSON.stringify(allToolbarButtons)}`);
  }

  if (rendererErrors.length) throw new Error(`Renderer errors: ${rendererErrors.join(' | ')}`);
  return { focusState, desktopHierarchy, wideHierarchy, compactHierarchy, classicState, clippingState, cardClickPoint, directCardOpen, floatingInitial, addDrawerOffset, pinnedToolbar, toolbarHeights, toolbarModes, allToolbarButtons, screenshotPath, settingsScreenshotPath, toolbarScreenshotPath };
  } catch (error) {
    throw new Error(`${smokeStep}: ${error.message}${rendererErrors.length ? ` | ${rendererErrors.join(' | ')}` : ''}`);
  }
}

app.whenReady().then(async () => {
  try {
    const result = await run();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    app.exit(1);
  }
});

app.on('will-quit', () => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});
