'use strict';
const fs = require('fs');
const z = require('zlib');
const txt = fs.readFileSync(__dirname + '/cursor-url.txt', 'utf8');
const m = txt.match(/base64,([^"]+)/);
const buf = Buffer.from(m[1], 'base64');
fs.writeFileSync(__dirname + '/cursor-test.png', buf);
let o = 8;
while (o < buf.length) {
  const len = buf.readUInt32BE(o);
  const type = buf.slice(o + 4, o + 8).toString('ascii');
  if (type === 'IDAT') {
    const data = buf.slice(o + 8, o + 8 + len);
    const raw = z.inflateSync(data);
    console.log('IDAT inflated', raw.length, 'expect', 33 * 32);
    break;
  }
  o += 12 + len;
}
