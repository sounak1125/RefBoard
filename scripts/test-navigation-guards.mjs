import assert from 'node:assert/strict';
import {
  sameFilePath,
  createSingleFlight,
  createAsyncQueue,
  promiseWithTimeout,
} from './navigation-guards.mjs';

assert.equal(sameFilePath('C:/Boards/Test.refboard', 'c:\\boards\\test.refboard'), true);
assert.equal(sameFilePath('C:\\Boards\\Test.refboard\\', 'c:/boards/test.refboard'), true);
assert.equal(sameFilePath('C:/Boards/A.refboard', 'C:/Boards/B.refboard'), false);
assert.equal(sameFilePath('', 'C:/Boards/A.refboard'), false);

const gate = createSingleFlight();
let calls = 0;
let release;
const first = gate.run(async () => {
  calls++;
  await new Promise(resolve => { release = resolve; });
  return 'done';
});
const second = gate.run(async () => {
  calls++;
  return 'wrong';
});
assert.equal(first, second);
assert.equal(gate.isActive(), true);
await new Promise(resolve => setTimeout(resolve, 0));
release();
assert.equal(await first, 'done');
assert.equal(calls, 1);
assert.equal(gate.isActive(), false);
assert.equal(await gate.run(async () => ++calls), 2);

const queue = createAsyncQueue();
const order = [];
const queuedA = queue.run(async () => {
  order.push('a-start');
  await new Promise(resolve => setTimeout(resolve, 5));
  order.push('a-end');
});
const queuedB = queue.run(async () => { order.push('b'); });
await Promise.all([queuedA, queuedB]);
assert.deepEqual(order, ['a-start', 'a-end', 'b']);

const quick = await promiseWithTimeout(Promise.resolve(false), 100);
assert.deepEqual(quick, { timedOut: false, value: false });
const slow = await promiseWithTimeout(new Promise(resolve => setTimeout(() => resolve(true), 30)), 5);
assert.equal(slow.timedOut, true);

console.log('navigation-guards: all checks passed');
