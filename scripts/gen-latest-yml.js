'use strict';
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const exe = process.argv[2];
if (!exe) {
  console.error('Usage: node gen-latest-yml.js <path-to-setup.exe>');
  process.exit(1);
}
const buf = fs.readFileSync(exe);
const sha512 = crypto.createHash('sha512').update(buf).digest('base64');
const base = path.basename(exe);
const ver = base.match(/Setup-(.+)\.exe$/)?.[1] || '0.0.0';
const yml = `version: ${ver}
files:
  - url: ${base}
    sha512: ${sha512}
    size: ${buf.length}
path: ${base}
sha512: ${sha512}
releaseDate: '${new Date().toISOString()}'
`;
const out = path.join(path.dirname(exe), `latest-${ver}.yml`);
fs.writeFileSync(out, yml);
console.log(`Wrote ${out}`);
