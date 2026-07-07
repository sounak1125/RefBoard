'use strict';
const fs = require('fs');
const buf = fs.readFileSync(__dirname + '/cursor-test.png');
let o = 8;
while (o < buf.length) {
  const len = buf.readUInt32BE(o);
  const type = buf.slice(o + 4, o + 8).toString('ascii');
  console.log(type, len, 'at', o);
  o += 12 + len;
}
