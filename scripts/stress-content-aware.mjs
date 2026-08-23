/* Parent for the content-aware fill Electron stress test.
 *
 * Spawns the same Worker path the app uses, samples the Electron process tree
 * from outside so a hard kill still leaves numbers, and writes a JSON report.
 *
 *   node scripts/stress-content-aware.mjs
 *   node scripts/stress-content-aware.mjs --width=1920 --height=1080 --mask=medium --board-mb=0
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'content-aware-out');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const width = flag('width', '3840');
const height = flag('height', '2160');
const mask = flag('mask', 'large');
const quality = flag('quality', 'balanced');
const boardMb = flag('board-mb', '300');

await mkdir(OUT, { recursive: true });
const logPath = path.join(OUT, 'stress-worker.log');
const innerReport = path.join(OUT, 'stress-worker-report.json');
const parentReport = path.join(OUT, 'stress-parent-report.json');

const started = Date.now();
const rssSamples = [];
let child = null;

function sampleRss() {
  if (!child?.pid) return;
  try {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${child.pid} -or $_.ProcessId -eq ${child.pid} } | Select-Object ProcessId,Name,WorkingSetSize | ConvertTo-Json -Compress`,
    ], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', chunk => { out += chunk; });
    ps.on('close', () => {
      try {
        const parsed = JSON.parse(out || '[]');
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const workingSetMb = rows.reduce((n, row) => n + (Number(row.WorkingSetSize) || 0), 0) / (1024 * 1024);
        rssSamples.push({
          at: Date.now() - started,
          workingSetMb: +workingSetMb.toFixed(1),
          processes: rows.map(row => ({
            pid: row.ProcessId,
            name: row.Name,
            mb: +((Number(row.WorkingSetSize) || 0) / (1024 * 1024)).toFixed(1),
          })),
        });
        console.log(`[parent ${(rssSamples.at(-1).at / 1000).toFixed(1)}s] tree RSS ${workingSetMb.toFixed(0)}MB (${rows.length} processes)`);
      } catch {
        /* ignore a partial PowerShell snapshot */
      }
    });
  } catch {
    /* sampling is best-effort */
  }
}

const env = {
  ...process.env,
  REFBOARD_STRESS_W: width,
  REFBOARD_STRESS_H: height,
  REFBOARD_STRESS_MASK: mask,
  REFBOARD_STRESS_QUALITY: quality,
  REFBOARD_STRESS_BOARD_MB: boardMb,
  REFBOARD_STRESS_LOG: logPath,
  REFBOARD_STRESS_REPORT: innerReport,
};

console.log(`content-aware fill Electron stress — ${width}x${height} ${mask} ${quality} board=${boardMb}MB`);
console.log(`log: ${logPath}`);

child = spawn(electronPath, [path.join(__dirname, 'stress-content-aware-worker.js')], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
});

const rssTimer = setInterval(sampleRss, 3000);
sampleRss();

const exit = await new Promise(resolve => {
  child.on('close', (code, signal) => resolve({ code, signal }));
});
clearInterval(rssTimer);

const peak = rssSamples.reduce((n, s) => Math.max(n, s.workingSetMb || 0), 0);
const report = {
  width: Number(width),
  height: Number(height),
  mask,
  quality,
  boardMb: Number(boardMb),
  elapsedMs: Date.now() - started,
  exitCode: exit.code,
  signal: exit.signal,
  peakTreeRssMb: +peak.toFixed(1),
  samples: rssSamples,
  innerReport,
  logPath,
};
await writeFile(parentReport, JSON.stringify(report, null, 2));

console.log('');
console.log(`elapsed ${(report.elapsedMs / 1000).toFixed(1)}s · exit ${exit.code}${exit.signal ? ` signal ${exit.signal}` : ''} · peak tree RSS ${peak.toFixed(0)}MB`);
if (exit.code === 70) console.log('outcome: renderer process gone (typical OOM / crash)');
else if (exit.code === 71) console.log('outcome: child process gone');
else if (exit.code === 73) console.log('outcome: worker reported an error');
else if (exit.code === 0) console.log('outcome: fill completed');
else console.log('outcome: process exited without a clean fill result');

process.exit(exit.code == null ? 1 : exit.code);
