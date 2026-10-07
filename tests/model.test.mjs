import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, produce, readBatch, commit, restart, lag, assign } from '../src/model.ts';

test('same keys route consistently and offsets are local to each partition', () => {
  let state = initialState();
  state = produce(state, 'customer-42', 'created');
  state = produce(state, 'customer-42', 'paid');
  const records = state.partitions.flat();
  assert.equal(records[0].partition, records[1].partition);
  assert.deepEqual(records.map(r => r.offset), [0, 1]);
});
test('reading is independent from commit; crash redelivers uncommitted records', () => {
  let state = produce(initialState(), 'order-1', 'created');
  state = readBatch(state, 'billing');
  assert.equal(lag(state, 'billing'), 1);
  assert.equal(state.groups.billing.position.reduce((a,b)=>a+b), 1);
  state = restart(state, 'billing');
  assert.equal(state.groups.billing.position.reduce((a,b)=>a+b), 0);
  state = readBatch(state, 'billing');
  state = commit(state, 'billing');
  assert.equal(lag(state, 'billing'), 0);
  assert.equal(lag(state, 'analytics'), 1);
  assert.equal(state.partitions.flat().length, 1);
});
test('commit is the next offset and survives restart', () => {
  let state = produce(initialState(), 'x', 'one');
  state = commit(readBatch(state, 'billing'), 'billing');
  assert.equal(state.groups.billing.committed.reduce((a,b)=>a+b), 1);
  state = restart(state, 'billing');
  assert.equal(state.groups.billing.position.reduce((a,b)=>a+b), 1);
  assert.equal(readBatch(state, 'billing').lastRead.length, 0);
});
test('classic group has one owner per partition and surplus consumers idle', () => {
  assert.deepEqual(assign(3, 2), [0, 1, 0]);
  assert.deepEqual(assign(3, 4), [0, 1, 2]);
  assert.throws(() => assign(3, 0));
});
test('invalid and oversized events do not mutate state', () => {
  const state = initialState();
  assert.throws(() => produce(state, '', 'event'));
  assert.throws(() => produce(state, 'x', 'a'.repeat(501)));
  assert.equal(state.partitions.flat().length, 0);
});
