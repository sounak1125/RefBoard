'use strict';
/* Electron stress for the content-aware fill worker.
 *
 * Replays the path that closed the app: a classic Worker in the renderer,
 * Balanced quality, a 4K frame with a ~1.3 megapixel hole, the same time
 * budget the host uses, plus extra renderer buffers to stand in for a loaded
 * board. Main logs render-process-gone / child-process-gone and samples RSS
 * so a silent OOM still leaves a trail.
 *
 *   node scripts/stress-content-aware.mjs
 *   npx electron scripts/stress-content-aware-worker.js
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const startedAt = Date.now();
const logPath = process.env.REFBOARD_STRESS_LOG
  || path.join(__dirname, '..', 'content-aware-out', 'stress-worker.log');
const reportPath = process.env.REFBOARD_STRESS_REPORT
  || path.join(__dirname, '..', 'content-aware-out', 'stress-worker-report.json');

fs.mkdirSync(path.dirname(logPath), { recursive: true });

const query = {
  w: process.env.REFBOARD_STRESS_W || '3840',
  h: process.env.REFBOARD_STRESS_H || '2160',
  mask: process.env.REFBOARD_STRESS_MASK || 'large',
  quality: process.env.REFBOARD_STRESS_QUALITY || 'balanced',
  boardMb: process.env.REFBOARD_STRESS_BOARD_MB || '300',
};

let finished = false;
let lastHeartbeat = Date.now();
let lastProgress = null;
const samples = [];
const events = [];

function stamp() {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

function writeLog(line) {
  const text = `[${stamp()}s] ${line}`;
  console.log(text);
  try { fs.appendFileSync(logPath, `${text}\n`); } catch (err) {}
}

function writeReport(extra) {
  const body = {
    ok: extra.ok === true,
    outcome: extra.outcome || 'unknown',
    elapsedMs: Date.now() - startedAt,
    query,
    lastProgress,
    lastHeartbeatAgeMs: Date.now() - lastHeartbeat,
    samples,
    events,
    ...extra,
  };
  try { fs.writeFileSync(reportPath, JSON.stringify(body, null, 2)); } catch (err) {}
}

function finish(code, outcome, extra = {}) {
  if (finished) return;
  finished = true;
  writeLog(`finish ${outcome} (exit ${code})`);
  writeReport({ ok: code === 0, outcome, exitCode: code, ...extra });
  app.exit(code);
}

app.setPath('userData', path.join(os.tmpdir(), 'refboard-stress-content-aware'));
app.on('window-all-closed', () => {
  if (!finished) finish(1, 'window-all-closed');
});

app.on('render-process-gone', (_event, _wc, details) => {
  const payload = {
    reason: details?.reason || 'unknown',
    exitCode: details?.exitCode,
    killed: !!details?.killed,
  };
  events.push({ type: 'render-process-gone', at: Date.now() - startedAt, ...payload });
  writeLog(`RENDER-PROCESS-GONE reason=${payload.reason} exitCode=${payload.exitCode} killed=${payload.killed}`);
  finish(70, 'render-process-gone', { details: payload });
});

app.on('child-process-gone', (_event, details) => {
  const payload = {
    type: details?.type || 'unknown',
    reason: details?.reason || 'unknown',
    exitCode: details?.exitCode,
    serviceName: details?.serviceName,
    name: details?.name,
  };
  events.push({ type: 'child-process-gone', at: Date.now() - startedAt, ...payload });
  writeLog(`CHILD-PROCESS-GONE type=${payload.type} reason=${payload.reason} exitCode=${payload.exitCode} name=${payload.name || payload.serviceName || ''}`);
  if (payload.type === 'GPU' || payload.reason === 'oom' || payload.reason === 'crashed') {
    finish(71, 'child-process-gone', { details: payload });
  }
});

function sampleMetrics() {
  try {
    const metrics = app.getAppMetrics();
    let workingSetKb = 0;
    let peakWorkingSetKb = 0;
    const parts = metrics.map(m => {
      const ws = m.memory?.workingSetSize || 0;
      const peak = m.memory?.peakWorkingSetSize || 0;
      workingSetKb += ws;
      peakWorkingSetKb += peak;
      return {
        type: m.type,
        pid: m.pid,
        workingSetMb: +(ws / 1024).toFixed(1),
        peakWorkingSetMb: +(peak / 1024).toFixed(1),
      };
    });
    const sample = {
      at: Date.now() - startedAt,
      workingSetMb: +(workingSetKb / 1024).toFixed(1),
      peakWorkingSetMb: +(peakWorkingSetKb / 1024).toFixed(1),
      parts,
      lastProgress,
    };
    samples.push(sample);
    writeLog(`rss=${sample.workingSetMb}MB peak=${sample.peakWorkingSetMb}MB `
      + `parts=${parts.map(p => `${p.type}:${p.workingSetMb}`).join(',')} `
      + (lastProgress ? `stage=${lastProgress.stage} ${Math.round(lastProgress.percent || 0)}%` : 'stage=idle'));
    writeReport({ outcome: finished ? 'done' : 'running', ok: false });
  } catch (err) {
    writeLog(`metrics failed: ${err?.message || err}`);
  }
}

app.whenReady().then(async () => {
  writeLog(`start ${JSON.stringify(query)}`);
  writeLog(`log=${logPath}`);

  const win = new BrowserWindow({
    show: true,
    width: 960,
    height: 640,
    backgroundColor: '#141519',
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      spellcheck: false,
    },
  });

  ipcMain.on('stress-heartbeat', () => {
    lastHeartbeat = Date.now();
  });
  ipcMain.on('stress-progress', (_event, data) => {
    lastProgress = data;
    writeLog(`progress ${data.stage || '?'} ${Math.round(data.percent || 0)}%`);
  });
  ipcMain.on('stress-result', (_event, report) => {
    if (report?.error) {
      writeLog(`worker error: ${report.error}`);
      finish(73, 'worker-error', { error: report.error, report });
      return;
    }
    writeLog(`worker complete algorithm=${report.algorithmUsed} time=${report.processingTime}ms confidence=${report.confidence}`);
    finish(0, 'completed', { report });
  });

  const timer = setInterval(sampleMetrics, 2000);
  app.on('will-quit', () => clearInterval(timer));
  sampleMetrics();

  const html = path.join(__dirname, 'stress-content-aware-worker.html');
  await win.loadFile(html, { query }).catch(err => {
    writeLog(`load failed: ${err?.message || err}`);
    finish(1, 'load-failed', { error: String(err?.message || err) });
  });
});
