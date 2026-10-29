// Runs old-engine.mjs on every case, one process each, sequentially.
//   node run-old-engine.mjs <casesDir> <outDir> [timeoutMinutes]
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [casesDir, outDir, minutes = '20'] = process.argv.slice(2);
const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'old-engine.mjs');
const ids = readdirSync(casesDir).filter(d => existsSync(path.join(casesDir, d, 'case.json'))).sort();
for (const id of ids) {
  const odir = path.join(outDir, id);
  mkdirSync(odir, { recursive: true });
  if (existsSync(path.join(odir, 'old.json')) && existsSync(path.join(odir, 'old.png'))) {
    console.log(`${id} already done`);
    continue;
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--max-old-space-size=16384', runner, path.join(casesDir, id), odir],
    { encoding: 'utf8', timeout: Number(minutes) * 60_000 });
  if (r.status !== 0) {
    const info = { engine: 'old', error: r.error ? String(r.error.message) : (r.stderr || '').slice(-600), ms: Date.now() - t0, timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') };
    writeFileSync(path.join(odir, 'old.json'), JSON.stringify(info, null, 2));
    console.log(`${id} FAILED ${JSON.stringify(info).slice(0, 300)}`);
  } else {
    console.log(`${id} ${r.stdout.trim()}`);
  }
}
console.log('old engine batch done');
