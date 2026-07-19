import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function extractLocalSpecifiers(source) {
  const found = new Set();
  const patterns = [
    /\b(?:import|export)\s+[^;]*?\s+from\s*(['"])(\.\.?\/[^'"]+)\1/g,
    /\bimport\s*(['"])(\.\.?\/[^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])(\.\.?\/[^'"]+)\1\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.add(match[2]);
  }
  return [...found];
}

function relativeRuntimePath(absolutePath) {
  const relative = normalizePath(path.relative(rootDir, absolutePath));
  if (!relative || relative === '..' || relative.startsWith('../')) return null;
  return relative;
}

function buildFilePatterns(files) {
  return (Array.isArray(files) ? files : [])
    .filter(entry => typeof entry === 'string' && entry.trim())
    .map(entry => normalizePath(entry.trim()));
}

function matchesBuildFiles(relativePath, patterns) {
  let included = false;
  for (const rawPattern of patterns) {
    const excluded = rawPattern.startsWith('!');
    const pattern = excluded ? rawPattern.slice(1) : rawPattern;
    if (path.matchesGlob(relativePath, pattern)) included = !excluded;
  }
  return included;
}

async function main() {
  const [indexHtml, packageText] = await Promise.all([
    fs.readFile(path.join(rootDir, 'index.html'), 'utf8'),
    fs.readFile(path.join(rootDir, 'package.json'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageText);
  const patterns = buildFilePatterns(packageJson?.build?.files);
  if (!patterns.length) throw new Error('package.json > build.files has no usable string patterns');

  const entrySpecifiers = extractLocalSpecifiers(indexHtml)
    .filter(specifier => normalizePath(specifier).startsWith('scripts/'));
  const queue = entrySpecifiers.map(specifier => ({
    absolutePath: path.resolve(rootDir, specifier),
    importedBy: 'index.html',
  }));
  const resolvedModules = new Map();
  const unresolved = [];

  while (queue.length) {
    const current = queue.shift();
    const relativePath = relativeRuntimePath(current.absolutePath);
    if (!relativePath || resolvedModules.has(relativePath)) continue;
    if (!/\.(?:mjs|js)$/i.test(relativePath)) continue;
    let source;
    try {
      source = await fs.readFile(current.absolutePath, 'utf8');
    } catch (error) {
      unresolved.push({ relativePath, importedBy: current.importedBy, error });
      continue;
    }
    resolvedModules.set(relativePath, current.importedBy);
    for (const specifier of extractLocalSpecifiers(source)) {
      queue.push({
        absolutePath: path.resolve(path.dirname(current.absolutePath), specifier),
        importedBy: relativePath,
      });
    }
  }

  const missing = [...resolvedModules]
    .filter(([relativePath]) => !matchesBuildFiles(relativePath, patterns))
    .sort(([left], [right]) => left.localeCompare(right));

  for (const item of unresolved.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    console.error(`[build-files] UNRESOLVED: ${item.relativePath} imported by ${item.importedBy}`);
  }
  for (const [relativePath, importedBy] of missing) {
    console.error(`[build-files] MISSING: ${relativePath} imported by ${importedBy}`);
  }
  if (unresolved.length || missing.length) {
    console.error(`[build-files] FAILED: ${unresolved.length} unresolved, ${missing.length} not covered by package.json > build.files`);
    process.exitCode = 1;
    return;
  }

  console.log(`BUILD_FILES_GUARD_OK: ${resolvedModules.size} local runtime modules covered by ${patterns.length} build.files patterns`);
}

main().catch(error => {
  console.error(`[build-files] ERROR: ${error?.stack || error}`);
  process.exitCode = 1;
});
