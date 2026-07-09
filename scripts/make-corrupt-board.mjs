#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const inputPath = process.argv[2];

if (!inputPath) {
  console.error('Usage: node scripts/make-corrupt-board.mjs <path-to-board.refboard>');
  process.exit(1);
}

const source = await readFile(inputPath, 'utf8');
const board = JSON.parse(source);

if (Array.isArray(board.images)) {
  for (const image of board.images) {
    if (image && typeof image === 'object') {
      image.data = 'data:image/png;base64,BROKEN';
    }
  }
}

const parsed = path.parse(inputPath);
const outputPath = path.join(parsed.dir, `${parsed.name}-corrupt.refboard`);

await writeFile(outputPath, JSON.stringify(board, null, 2) + '\n', 'utf8');
console.log(outputPath);
