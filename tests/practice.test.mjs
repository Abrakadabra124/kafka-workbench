import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePractice, executePractice, practiceTasks } from '../server/practice-workspace.mjs';

const archive = [0, 1, 2].map((offset) => ({
  partition: 0,
  offset,
  key: `E${offset}`,
  value: offset === 1 ? '{broken' : `{"eventId":"E${offset}","amount":100}`,
}));
const snapshot = {
  partitions: [0, 1, 2].map((partition) => ({
    partition,
    replicas: [1, 2, 3],
    isr: [1, 2, 3],
    leader: 1,
    end: partition ? 0 : 3,
    committed: partition ? 0 : 3,
  })),
};
const state = () => ({
  archive,
  faultObserved: true,
  recoveryAcknowledged: true,
  faultCode: 'SchemaViolation',
  attempt: 1,
});
const poison = () => ({
  source: archive,
  processed: [archive[0], archive[2]],
  quarantine: [
    {
      key: 'wb-poison-quarantine:0:1',
      value: JSON.stringify({
        sourceTopic: 'wb-poison-quarantine',
        partition: 0,
        offset: 1,
        payload: '{broken',
        reason: 'SCHEMA_VIOLATION',
      }),
    },
  ],
  minIsr: 2,
});
test('quarantine requires original bytes, coordinates, correct output and observed failure; low lag alone never passes', () => {
  assert.equal(evaluatePractice('poison-quarantine', state(), snapshot, poison()).passed, true);
  for (const mutate of [
    (e) => (e.quarantine = []),
    (e) => (e.processed = [archive[0]]),
    (e) => (e.quarantine[0].value = '{}'),
    (e) => e.processed.push(archive[0]),
  ]) {
    const evidence = poison();
    mutate(evidence);
    assert.equal(evaluatePractice('poison-quarantine', state(), snapshot, evidence).passed, false);
  }
  assert.equal(
    evaluatePractice('poison-quarantine', { ...state(), faultObserved: false }, snapshot, poison())
      .passed,
    false,
  );
});
test('ISR recovery retains original guarantee and requires a real rejected write followed by confirmed control record', () => {
  const observed = {
    source: [
      ...archive,
      { partition: 0, offset: 3, key: 'recovery-proof', value: 'acks=all;minISR=3' },
    ],
    minIsr: 3,
  };
  const s = { ...state(), faultCode: 'NotEnoughReplicasException', proof: observed.source.at(-1) };
  assert.equal(evaluatePractice('isr-write-gate', s, snapshot, observed).passed, true);
  assert.equal(
    evaluatePractice('isr-write-gate', s, snapshot, {
      ...observed,
      source: [...observed.source, observed.source.at(-1)],
    }).passed,
    false,
  );
  assert.equal(
    evaluatePractice('isr-write-gate', s, snapshot, { ...observed, minIsr: 2 }).passed,
    false,
  );
  assert.equal(
    evaluatePractice('isr-write-gate', { ...s, faultCode: 'Unknown' }, snapshot, observed).passed,
    false,
  );
  assert.equal(
    evaluatePractice('isr-write-gate', s, snapshot, { ...observed, source: archive }).passed,
    false,
  );
});
test('repair cannot precede fault, old evidence is invalidated and another fault requires a new attempt', async () => {
  for (const id of practiceTasks.map((t) => t.id)) {
    const s = { ...state(), faultObserved: false };
    let calls = 0;
    const context = {
      id,
      state: s,
      adapter: async () => {
        calls++;
        return {};
      },
      snapshot: async () => snapshot,
      healthy: async () => snapshot,
    };
    await assert.rejects(executePractice({ ...context, action: 'recover' }), /сбой/i);
    assert.equal(calls, 0);
    s.faultObserved = true;
    await assert.rejects(executePractice({ ...context, action: 'fault' }), /попытк/i);
    assert.equal(calls, 0);
    assert.equal(
      evaluatePractice(id, { ...state(), recoveryAcknowledged: false }, snapshot, poison()).passed,
      false,
    );
  }
});
test('retention recovery proves the gap and exact archived business records, not old offsets or zero lag', () => {
  const s = { ...state(), faultCode: 'OffsetOutOfRangeException' };
  const evidence = {
    source: archive.slice(1),
    recovered: archive.map((r) => ({ ...r, offset: r.offset + 20 })),
    start: 1,
    minIsr: 2,
  };
  assert.equal(evaluatePractice('retention-gap', s, snapshot, evidence).passed, true);
  for (const recovered of [
    [],
    archive.slice(1),
    [...archive, archive[0]],
    archive.map((r) => ({ ...r, value: 'changed' })),
  ])
    assert.equal(
      evaluatePractice('retention-gap', s, snapshot, { ...evidence, recovered }).passed,
      false,
    );
  assert.equal(
    evaluatePractice('retention-gap', s, snapshot, { ...evidence, start: 0 }).passed,
    false,
  );
});
test('all three practice tasks explain symptoms, safe recovery, consequences and reference the matching model', () => {
  assert.equal(practiceTasks.length, 3);
  for (const task of practiceTasks)
    for (const key of ['id', 'title', 'description', 'hint', 'consequence'])
      assert.ok(task[key].length > 5);
});
