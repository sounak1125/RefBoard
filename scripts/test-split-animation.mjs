import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run the real layout/lifecycle functions with a controlled clock and native
// views. This catches jumps that a final-state-only smoke cannot detect.
const source = (await readFile(new URL('../main.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const names = ['clampSplitRatio', 'splitFrame', 'layoutViews', 'setPaneBounds', 'easeSplitMotion',
  'splitOpenProgress', 'stopSplitAnim', 'tickSplitAnim', 'startSplitAnim',
  'animateSplitClose', 'applySplitScreenX', 'splitStatePayload', 'sendSplitState',
  'enterSplit', 'requestSplitExit', 'requestWindowClose'];
const functions = names.map(name => {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `production function ${name} exists`);
  return match[0];
}).join('\n');
const sessionStart = source.indexOf("  ipcMain.on('board-session',");
const sessionEnd = source.indexOf('\n  });', sessionStart) + '\n  });'.length;
assert.ok(sessionStart > 0 && sessionEnd > sessionStart);
const frameStart = source.indexOf("  ipcMain.on('split-animation-frame',");
const frameEnd = source.indexOf('\n  });', frameStart) + '\n  });'.length;
assert.ok(frameStart > 0 && frameEnd > frameStart);

function harness() {
  let now = 1000, failure = false, removed = 0, nextId = 0;
  let resolveLoad, rejectLoad;
  const timers = new Map(), frames = [], views = [], handlers = new Map();
  const st = { primaryView: { updates: 0, getBounds() { return this.bounds || {}; },
    setBounds(bounds) { this.bounds = bounds; this.updates++; } },
    secondaryView: null, secondaryLoading: false, splitRatio: 0.5, splitAnim: null,
    animTimer: 0, layout: { addChildView(view) {
      assert.equal(view.bounds.x, 1200, 'the pane is offscreen before attachment');
    } } };
  const win = { isDestroyed: () => false, getContentSize: () => [1200, 800],
    getContentBounds: () => ({ x: 100, width: 1200 }), setMinimumSize() {} };
  const primary = { isDestroyed: () => false, isCrashed: () => false,
    send: () => { st.primaryCloseRequested = true; } };
  const context = vm.createContext({
    Math, performance: { now: () => now }, console: { warn() {} },
    SPLIT_RATIO_DEFAULT: 0.5, SPLIT_RATIO_MIN: 0.25, SPLIT_RATIO_MAX: 0.75,
    SPLIT_GAP: 6, SPLIT_ANIM_MS: 400, TITLEBAR_H: 34,
    SPLIT_MIN_WIDTH: 1000, WINDOW_MIN_HEIGHT: 480, MAX_BOARD_WINDOWS: 4,
    paneState: () => st, boardPaneCount: () => 1,
    crypto: { randomUUID: () => `split-${++nextId}` }, boardWebPreferences: () => ({}),
    registerSender() {}, attachWebContentsSafety() {}, sendBlockedBoardPath() {},
    startPaneActivityPolling() {}, stopSplitDrag() {}, sendPaneActivity() {},
    windowForEvent: () => win,
    primaryWebContents: () => primary,
    isSecondarySender: (_win, sender) => sender === st.secondaryView?.webContents,
    ipcMain: { on: (name, fn) => handlers.set(name, fn) },
    setTimeout(fn) { const id = ++nextId; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    sendToPanes: (_win, _channel, payload) => frames.push(payload),
    destroySecondary() {
      context.stopSplitAnim(win); st.secondaryView = null; st.secondaryLoading = false; removed++;
    },
    WebContentsView: class {
      constructor() {
        this.webContents = { focus() {}, setBackgroundThrottling(allowed) { this.throttled = allowed; }, isDestroyed: () => false, isCrashed: () => false,
          send() {}, loadFile: () => failure ? Promise.reject(new Error('load failed'))
            : new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; }) };
        views.push(this);
      }
      getBounds() { return this.bounds || {}; }
      setBounds(bounds) { this.bounds = bounds; }
      setBackgroundColor() {}
    },
  });
  vm.runInContext(functions + '\n' + source.slice(sessionStart, sessionEnd)
    + '\n' + source.slice(frameStart, frameEnd), context);
  return { st, win, context, frames, views, timers,
    get removed() { return removed; },
    time(ms) { now += ms; },
    fail() { failure = true; },
    resolveLoad() { resolveLoad(); },
    rejectLoad() { rejectLoad(new Error('load cancelled')); },
    ready(value = true, sender = st.secondaryView?.webContents) {
      handlers.get('board-session')({ sender }, { startupComplete: value, ready: false });
    },
    frame(id = st.splitAnim?.id, sender = primary) {
      handlers.get('split-animation-frame')({ sender }, id);
    },
  };
}

{
  const h = harness(), { context: c, st, win } = h;
  const opening = c.enterSplit(win, 0.5);
  assert.equal(st.secondaryView.webContents.throttled, false, 'offscreen startup timers must run');
  assert.equal(c.splitOpenProgress(st), 0);
  assert.equal(c.splitFrame(win).contentWidth, 1200, 'loading does not shrink the primary board');
  h.time(2000);
  h.resolveLoad();
  assert.equal((await opening).opened, true);
  assert.equal(h.timers.size, 0, 'file load alone must not consume the slide animation');
  h.ready(false);
  assert.equal(h.timers.size, 0, 'early board-session reports must not start opening');
  h.ready(true, {});
  assert.equal(h.timers.size, 0, 'only the secondary renderer can report its readiness');
  h.ready();
  assert.equal(st.secondaryView.webContents.throttled, false, 'secondary keeps painting throughout the slide');
  assert.equal(h.frames.at(-1).animationDirection, 'in');
  assert.equal(c.splitOpenProgress(st), 0, 'first opening frame starts at zero');
  const started = st.splitAnim.t0;
  h.ready();
  assert.equal(st.splitAnim.t0, started, 'duplicate readiness cannot restart the slide');
  const widths = [c.splitFrame(win).contentWidth];
  for (let i = 0; i < 4; i++) {
    h.time(100); h.frame();
    const f = c.splitFrame(win);
    widths.push(f.contentWidth);
    assert.equal(st.secondaryView.bounds.x, f.secX);
    assert.equal(h.frames.at(-1).contentWidth, f.contentWidth, 'native bounds and renderer share a frame');
    assert.equal(st.primaryView.bounds.width, 1200, 'shared titlebar stays full width');
  }
  assert.deepEqual(widths, [1200, 1138, 900, 662, 600]);
  assert.equal(st.secondaryView.webContents.throttled, true, 'normal throttling resumes after settling');
  assert.equal(st.primaryView.updates, 1, 'unchanged native primary bounds are not applied every frame');
  assert.equal(st.splitAnim, null);
  assert.equal(h.timers.size, 0);
  assert.equal(h.frames.at(-1).animating, false);
  c.applySplitScreenX(win, 880);
  assert.equal(st.splitRatio, 0.65, 'divider resizing works after the animation');
  assert.equal(c.splitFrame(win).contentWidth, 780);
  c.startSplitAnim(win, 'out');
  assert.equal(h.frames.at(-1).animationDirection, 'out');
  h.time(200); h.frame();
  assert.equal(c.splitFrame(win).contentWidth, 990, 'closing also has an intermediate frame');
  h.time(200); h.frame();
  assert.equal(st.secondaryView, null);
  assert.equal(h.timers.size, 0);
}

// Reverse an opening halfway through without jumping to a different easing value.
{
  const h = harness(), { context: c, st, win } = h;
  const opening = c.enterSplit(win, 0.75); h.resolveLoad(); await opening; h.ready();
  h.time(100); c.tickSplitAnim(win);
  const before = c.splitFrame(win).secX;
  c.applySplitScreenX(win, 400);
  assert.equal(st.splitRatio, 0.75, 'drag events cannot fight an active slide');
  c.animateSplitClose(win);
  assert.equal(c.splitFrame(win).secX, before, 'reversing keeps the exact current position');
  h.time(400); h.frame();
  assert.equal(st.secondaryView, null);
}

// Only the primary renderer and the current animation can advance native views.
{
  const h = harness(), { context: c, st, win } = h;
  const opening = c.enterSplit(win, 0.5); h.resolveLoad(); await opening; h.ready();
  const firstId = st.splitAnim.id;
  h.time(100);
  const count = h.frames.length;
  h.frame('stale-id'); h.frame(firstId, st.secondaryView.webContents);
  assert.equal(h.frames.length, count);
  h.frame();
  assert.ok(h.frames.at(-1).contentWidth < 1200);
  c.animateSplitClose(win);
  const reversedCount = h.frames.length;
  h.frame(firstId);
  assert.equal(h.frames.length, reversedCount, 'old callbacks cannot advance a reversed transition');
  h.time(500);
  const fallback = [...h.timers.values()][0];
  fallback();
  assert.equal(st.secondaryView, null, 'the deadline completes a slide if RAF stops');
  assert.equal(h.timers.size, 0);
}

// Failure and cancellation cannot leave a blank pane or revive a removed one.
{
  const h = harness(); h.fail();
  assert.equal((await h.context.enterSplit(h.win, 0.5)).reason, 'load-failed');
  assert.equal(h.st.secondaryView, null);
  assert.equal(h.timers.size, 0);
}
{
  const h = harness();
  const opening = h.context.enterSplit(h.win, 0.5);
  assert.equal(h.context.requestSplitExit(h.win).closed, true);
  h.resolveLoad();
  assert.equal((await opening).reason, 'cancelled');
  assert.equal(h.st.secondaryView, null);
  assert.equal(h.timers.size, 0);
}
{
  const h = harness();
  const opening = h.context.enterSplit(h.win, 0.5);
  h.context.requestWindowClose(h.win);
  assert.equal(h.st.primaryCloseRequested, true, 'closing during startup reaches the primary save prompt');
  h.rejectLoad();
  assert.equal((await opening).reason, 'cancelled', 'an aborted load after closing is not reported as an open error');
  assert.equal(h.st.secondaryView, null);
}

// Chromium can suspend RAF for an offscreen view. Only secondary startup may
// fall back to a timer; normal board transitions still wait for painted frames.
const html = (await readFile(new URL('../index.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const nextUiFrame = html.match(/function nextUiFrame\([^]*?^}/m)?.[0];
assert.ok(nextUiFrame);
for (const [pane, ready, fallback] of [['secondary', false, true], ['secondary', true, false], ['primary', false, false]]) {
  const frames = [], timers = new Map();
  const c = vm.createContext({ BOARD_PANE: pane, appStartupComplete: ready,
    requestAnimationFrame: fn => frames.push(fn),
    setTimeout: fn => { timers.set(1, fn); return 1; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(nextUiFrame, c);
  let resolved = false;
  const waiting = c.nextUiFrame().then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(timers.size, fallback ? 1 : 0);
  if (fallback) timers.get(1)();
  else { frames.shift()(); frames.shift()(); }
  await waiting;
  assert.equal(resolved, true);
}

console.log('split animation tests passed — ready gating, intermediate frames, resize, reversal, failure and cancellation');

// The visible edge can move each frame, but reallocating the canvas each time
// clears its pixels and stalls the slide. Exercise the actual renderer sizing
// functions at high DPI so CSS sizing cannot silently stretch the backing.
function rendererFunctions(names) {
  return names.map(name => {
    const match = html.match(new RegExp(`function ${name}\\([^]*?^}`, 'm'));
    assert.ok(match, `renderer function ${name} exists`);
    return match[0];
  }).join('\n');
}

{
  let backingWidth = 2400, backingHeight = 1600, widthWrites = 0, heightWrites = 0;
  let redraws = 0;
  const boardClasses = new Set(['board-active', 'titlebar-revealed']);
  const canvas = {
    get width() { return backingWidth; },
    set width(value) { backingWidth = value; widthWrites++; },
    get height() { return backingHeight; },
    set height(value) { backingHeight = value; heightWrites++; },
    style: { width: '1200px', height: '800px' },
  };
  const c = vm.createContext({
    canvas, splitContentWidth: 1200, splitAnimating: true, splitActive: true,
    splitDragging: false, BOARD_PANE: 'primary', innerWidth: 1200, innerHeight: 800,
    devicePixelRatio: 2, chromeLeft: () => 0, titlebarH: () => 34,
    document: {
      documentElement: { classList: { contains: () => false } },
      body: { classList: { contains: name => boardClasses.has(name) } },
    },
    invalidate: () => { redraws++; },
  });
  vm.runInContext(rendererFunctions(['boardLayoutSize', 'boardCanvasSize', 'resize']), c);
  function assertRasterScale() {
    assert.equal(canvas.width / parseFloat(canvas.style.width), 2, 'the raster stays at native DPI instead of stretching');
    assert.equal(canvas.height / parseFloat(canvas.style.height), 2);
  }
  for (const width of [1200, 1150, 1000, 800, 600]) {
    c.splitContentWidth = width;
    c.resize();
    assert.equal(c.boardLayoutSize().w, width, 'hit testing and layout retain the visible pane width');
    assert.equal(canvas.width, 2400, 'opening preserves the full backing behind the clipped edge');
    assertRasterScale();
  }
  assert.equal(widthWrites, 0);
  assert.equal(heightWrites, 0);
  assert.equal(redraws, 0, 'moving the clipped edge alone does not redraw the board');
  c.splitAnimating = false;
  c.resize();
  assert.equal(canvas.width, 1200, 'settled split gets its exact visible backing size');
  assert.equal(canvas.style.width, '600px');
  assert.equal(widthWrites, 1);
  assert.equal(heightWrites, 1, 'settling crops the full backing to the visible height once');
  assertRasterScale();

  c.splitAnimating = true;
  c.resize();
  assert.equal(canvas.width, 2400, 'closing prepares the complete area before it is revealed');
  const preparedWrites = widthWrites;
  for (const width of [600, 700, 900, 1100, 1200]) {
    c.splitContentWidth = width;
    c.resize();
    assert.equal(widthWrites, preparedWrites, 'closing never reallocates between frames');
    assert.equal(heightWrites, 2, 'closing preserves the prepared full-height backing');
    assertRasterScale();
  }
  c.splitAnimating = false;
  c.splitActive = false;
  c.splitContentWidth = 0;
  c.resize();
  assert.equal(canvas.width, 2400);
  assert.equal(widthWrites, 2, 'there is only one backing resize at each necessary boundary');
  assert.equal(redraws, 3, 'closing settles the height back to the revealed titlebar inset');
  assertRasterScale();

  c.innerHeight = 900;
  c.resize();
  c.resize();
  assert.equal(widthWrites, 2, 'height-only changes preserve width');
  assert.equal(heightWrites, 4, 'unchanged dimensions are not assigned again');
  assertRasterScale();
  c.BOARD_PANE = 'secondary';
  c.splitAnimating = true;
  c.splitContentWidth = 500;
  assert.equal(c.boardCanvasSize().w, 500, 'the secondary pane keeps its own normal canvas size');

  c.BOARD_PANE = 'primary';
  c.innerHeight = 800;
  boardClasses.delete('titlebar-revealed');
  c.resize();
  assert.equal(c.boardCanvasSize().h, 800, 'auto-hidden titlebars keep the full vertical raster during the slide');
  assert.equal(canvas.style.height, '800px');
  assertRasterScale();
  const verticalWrites = heightWrites;
  for (const width of [500, 800, 1100, 1200]) {
    c.splitContentWidth = width;
    c.resize();
    assert.equal(heightWrites, verticalWrites, 'moving past the titlebar never resizes or stretches pixels');
  }
  c.splitAnimating = false;
  c.resize();
  assert.equal(c.boardCanvasSize().h, 766, 'the settled split returns to its exact titlebar inset');
  assertRasterScale();
  c.splitAnimating = true;
  boardClasses.add('titlebar-revealed');
  assert.equal(c.boardCanvasSize().h, 800, 'hover changes cannot resize the backing during a split slide');
  boardClasses.delete('board-active');
  boardClasses.delete('titlebar-revealed');
  assert.equal(c.boardCanvasSize().h, 766, 'the landing page retains its existing inset');
}

// The vertical path starts at the actual painted position, even when split
// interrupts a titlebar reveal, reverses, or receives a late hover event.
{
  let paintedTop = 26;
  const properties = new Map();
  const classes = new Set(['board-active', 'titlebar-revealed']);
  const root = { style: {
    setProperty(name, value) { properties.set(name, value); paintedTop = parseFloat(value); },
    removeProperty: name => properties.delete(name),
  } };
  const c = vm.createContext({
    splitBoardMotion: null,
    boardRect: () => ({ top: paintedTop }),
    getComputedStyle: () => ({ getPropertyValue: () => '34px' }),
    document: { documentElement: root, body: { classList: { contains: name => classes.has(name) } } },
  });
  vm.runInContext(rendererFunctions(['updateSplitBoardMotion']), c);
  const frame = (animationId, progress, animationDirection = 'in') => c.updateSplitBoardMotion({
    split: true, animating: true, animationId, progress, animationDirection,
  });
  frame(null, 0);
  assert.equal(paintedTop, 26, 'loading freezes a partially revealed board without snapping down');
  frame('opening', 0);
  assert.equal(paintedTop, 26, 'starting the native slide does not reset the captured top');
  frame('opening', 0.5);
  assert.equal(paintedTop, 30);
  classes.delete('titlebar-revealed');
  frame('opening', 0.5);
  assert.equal(paintedTop, 30, 'the hover-hide timer cannot reverse an opening board');
  frame('opening', 1);
  assert.equal(paintedTop, 34);
  c.updateSplitBoardMotion({ split: true, animating: false });
  assert.equal(properties.size, 0, 'settling releases the temporary top override');

  frame('closing', 1, 'out');
  assert.equal(paintedTop, 34);
  frame('closing', 0.5, 'out');
  assert.equal(paintedTop, 17);
  classes.add('titlebar-revealed');
  frame('closing', 0.5, 'out');
  assert.equal(paintedTop, 17, 'hovering during close retargets from the current position');
  frame('closing', 0, 'out');
  assert.equal(paintedTop, 34, 'a hovered titlebar remains visible after closing');
  c.updateSplitBoardMotion({ split: false, animating: false });
  assert.equal(c.splitBoardMotion, null);

  paintedTop = 0;
  classes.delete('titlebar-revealed');
  frame('open-again', 0);
  frame('open-again', 0.5);
  assert.equal(paintedTop, 17);
  frame('reverse', 0.5, 'out');
  assert.equal(paintedTop, 17, 'reversal starts at the current top instead of the full titlebar height');
  frame('reverse', 0.25, 'out');
  assert.equal(paintedTop, 8.5);
  frame('reverse', 0, 'out');
  assert.equal(paintedTop, 0);
  c.updateSplitBoardMotion({ split: false });
  assert.equal(properties.size, 0, 'cancelled or failed split startup releases the offset');
}

// Animation requests are display paced. Repeated state messages must neither
// start parallel RAF loops nor leave old animation IDs running after reversal.
{
  let nextRaf = 1;
  const callbacks = new Map(), sent = [], events = new Map();
  const c = vm.createContext({
    BOARD_PANE: 'primary', splitAnimationId: null, splitAnimationRaf: 0,
    requestAnimationFrame(fn) { const id = nextRaf++; callbacks.set(id, fn); return id; },
    cancelAnimationFrame: id => callbacks.delete(id),
    window: {
      RefBoardAPI: { splitAnimationFrame: id => sent.push(id) },
      addEventListener: (name, fn) => events.set(name, fn),
    },
  });
  const pagehide = html.match(/^window\.addEventListener\('pagehide', \(\) => syncSplitAnimationFrames\(null\)\);$/m)?.[0];
  assert.ok(pagehide, 'renderer teardown cancels the animation frame loop');
  vm.runInContext(rendererFunctions(['requestSplitAnimationFrame', 'syncSplitAnimationFrames']) + '\n' + pagehide, c);
  function paintFrame() {
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const callback of pending) callback();
  }
  c.syncSplitAnimationFrames('opening');
  const firstRaf = c.splitAnimationRaf;
  c.syncSplitAnimationFrames('opening');
  assert.equal(c.splitAnimationRaf, firstRaf, 'duplicate IPC state cannot restart the frame clock');
  assert.equal(callbacks.size, 1);
  assert.deepEqual(sent, [], 'the first request waits until a paint opportunity');
  paintFrame();
  assert.deepEqual(sent, ['opening']);
  assert.equal(callbacks.size, 1);
  const oldRaf = c.splitAnimationRaf;
  c.syncSplitAnimationFrames('closing');
  assert.equal(callbacks.has(oldRaf), false, 'reversal cancels the previously queued frame');
  assert.equal(callbacks.size, 1);
  paintFrame();
  assert.deepEqual(sent, ['opening', 'closing']);
  c.syncSplitAnimationFrames(null);
  assert.equal(callbacks.size, 0, 'settling cancels the loop');
  paintFrame();
  assert.deepEqual(sent, ['opening', 'closing']);
  c.syncSplitAnimationFrames('reopening');
  assert.equal(callbacks.size, 1);
  events.get('pagehide')();
  assert.equal(callbacks.size, 0, 'page teardown cancels the loop');
  assert.equal(c.splitAnimationId, null);
  c.BOARD_PANE = 'secondary';
  c.syncSplitAnimationFrames('secondary');
  assert.equal(callbacks.size, 0, 'only the primary renderer drives native layout');
}

console.log('split renderer tests passed — stable canvas, native pixel scale, RAF pacing and cancellation');
