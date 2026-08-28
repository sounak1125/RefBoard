/**
 * Attach to a RefBoard window over CDP and evaluate an expression inside it.
 *
 * The window's page target is listed in /json/list before main.js's
 * loadFile('index.html') navigation commits, so an evaluate issued the moment a
 * target appears can be torn down mid-flight with "Execution context was
 * destroyed". The expressions these smokes run do guard themselves by waiting
 * for window.RefBoard.startupComplete, but that guard runs inside the very
 * context that dies, so it cannot save itself - the rejection comes from the
 * CDP layer, below the guard. On a fast machine the navigation usually wins and
 * the race is invisible; on a slower CI runner it is not.
 *
 * So: wait for a committed index.html document before evaluating, and retry the
 * whole attach if a context is destroyed anyway, since main.js reloads the
 * window once more when its first load fails.
 */

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Errors that mean "the context moved under us", not "the page is broken".
const TRANSIENT = /Execution context was destroyed|Cannot find context|Inspected target (?:navigated|closed)|Target closed|Session with given id not found|socket closed/i;

async function pageTarget(port) {
  let targets = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
    } catch { /* retry */ }
    if (targets.some(entry => entry.type === 'page')) break;
    await delay(100);
  }
  return targets.find(entry => entry.type === 'page' && /RefBoard|index\.html/i.test(`${entry.title} ${entry.url}`))
    || targets.find(entry => entry.type === 'page')
    || null;
}

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message));
    else handlers.resolve(message.result);
  };
  // A target that goes away mid-request would otherwise leave every caller
  // awaiting a promise that can never settle, turning a race into a hang.
  socket.onclose = () => {
    for (const handlers of pending.values()) handlers.reject(new Error('CDP socket closed'));
    pending.clear();
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (socket.readyState !== 1) { reject(new Error('CDP socket closed')); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return { send, close: () => { try { socket.close(); } catch { /* already gone */ } } };
}

// A committed index.html past the parsing stage. Before the navigation lands
// this is about:blank, whose context is destroyed the moment the real one
// arrives - which is precisely the window this waits out.
const READY = "/index\.html/.test(location.pathname) && document.readyState !== 'loading'";

async function evaluateOnce(port, expression, focusEmulation) {
  const target = await pageTarget(port);
  if (!target) throw new Error('RefBoard page target was not available');
  const { send, close } = await connect(target);
  try {
    await send('Runtime.enable');
    // Chromium dispatches focus and blur only while the document itself has
    // focus, and a window spawned by a test rarely holds the OS focus - it
    // loses it to whatever the machine does next. A smoke that puts the caret
    // in a field and then blurs it therefore passes or fails on what else is
    // running, which is no test at all. This tells the renderer to behave as
    // though it were frontmost, which is the state such a test means.
    if (focusEmulation) {
      try {
        await send('Emulation.setFocusEmulationEnabled', { enabled: true });
      } catch (error) {
        if (!TRANSIENT.test(error.message)) throw error;
      }
    }
    let ready = false;
    for (let attempt = 0; attempt < 300 && !ready; attempt++) {
      try {
        const probe = await send('Runtime.evaluate', { expression: READY, returnByValue: true });
        ready = probe.result?.value === true;
      } catch (error) {
        if (!TRANSIENT.test(error.message)) throw error;
      }
      if (!ready) await delay(100);
    }
    if (!ready) throw new Error('RefBoard renderer never reached a loaded index.html');
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    }
    return response.result.value;
  } finally {
    close();
  }
}

export async function evaluate(port, expression, { attempts = 4, focusEmulation = false } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await evaluateOnce(port, expression, focusEmulation);
    } catch (error) {
      lastError = error;
      // A page that throws is a test failure; a context that vanished is not.
      if (!TRANSIENT.test(error.message)) throw error;
      await delay(250);
    }
  }
  throw lastError;
}
