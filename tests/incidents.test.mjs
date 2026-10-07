import test from 'node:test';
import assert from 'node:assert/strict';
import { incidents } from '../content/incidents.mjs';
import { createIncidentState, actIncident, publicIncident } from '../server/incident-engine.mjs';

const solutions = {
  'lag-growth': ['downstream', 'repair-downstream'],
  'poison-pill': ['bad-record', 'quarantine'],
  'advertised-listeners': ['advertised-address', 'correct-listeners'],
  'insufficient-isr': ['replica-outage', 'restore-replicas'],
  'disk-full': ['storage', 'expand-capacity'],
  'duplicate-charge': ['split-commit', 'idempotent-reconcile'],
};
const act = (id, state, action, choice) =>
  actIncident(id, state, choice === undefined ? { action } : { action, choice });
function diagnosed(id) {
  let state = createIncidentState(id);
  for (const observation of publicIncident(id).observations.slice(0, 2))
    state = act(id, state, 'observe', observation.id);
  return act(id, state, 'hypothesis', solutions[id][0]);
}

test('public catalogue contains six complete cases and no grading keys', () => {
  assert.equal(incidents.length, 6);
  assert.equal(new Set(incidents.map((item) => item.id)).size, 6);
  for (const item of incidents) {
    assert.deepEqual(publicIncident(item.id), item);
    for (const list of ['observations', 'hypotheses', 'fixes']) {
      assert.equal(item[list].length, 3);
      assert.equal(new Set(item[list].map((option) => option.id)).size, 3);
      for (const option of item[list])
        assert.deepEqual(Object.keys(option).sort(), ['id', 'label']);
    }
    assert.ok(item.sources.length > 0);
    assert.doesNotMatch(
      JSON.stringify(item),
      /"(?:correctIndex|correct|answer|wrongFixes|model|solution)"/,
    );
    const returned = publicIncident(item.id);
    returned.observations[0].label = 'mutated';
    assert.notEqual(publicIncident(item.id).observations[0].label, 'mutated');
  }
});

for (const incident of incidents) {
  test(`${incident.id}: evidence -> hypothesis -> fix -> explicit verification`, () => {
    const original = createIncidentState(incident.id);
    assert.equal(original.history.length, 1);
    assert.equal(original.verified, false);
    assert.equal(original.phase, 'observe');
    let state = act(incident.id, original, 'verify');
    assert.equal(state.verified, false);
    state = act(incident.id, state, 'observe', incident.observations[0].id);
    state = act(incident.id, state, 'observe', incident.observations[0].id);
    assert.equal(state.observed.length, 1);
    state = act(incident.id, state, 'hypothesis', solutions[incident.id][0]);
    assert.equal(state.hypothesis, null);
    state = act(incident.id, state, 'observe', incident.observations[1].id);
    assert.equal(state.phase, 'hypothesis');
    state = act(incident.id, state, 'fix', solutions[incident.id][1]);
    assert.equal(state.fixed, false);
    state = act(incident.id, state, 'hypothesis', solutions[incident.id][0]);
    assert.equal(state.phase, 'fix');
    state = act(incident.id, state, 'verify');
    assert.equal(state.verified, false);
    state = act(incident.id, state, 'fix', solutions[incident.id][1]);
    assert.equal(state.fixed, true);
    assert.equal(state.verified, false);
    assert.equal(state.phase, 'verify');
    state = act(incident.id, JSON.parse(JSON.stringify(state)), 'verify');
    assert.equal(state.verified, true);
    assert.equal(state.phase, 'complete');
    assert.equal(state.flow, 'healthy');
    assert.equal(state.metrics.lag, 0);
    assert.equal(state.metrics.duplicates, 0);
    assert.ok(Object.values(state.nodes).every((value) => value === 'healthy'));
    assert.deepEqual(original, createIncidentState(incident.id));
    const reset = act(incident.id, state, 'reset');
    assert.deepEqual(reset, createIncidentState(incident.id));
  });

  test(`${incident.id}: every incorrect hypothesis and fix stays unverified`, () => {
    for (const hypothesis of incident.hypotheses.filter(
      (item) => item.id !== solutions[incident.id][0],
    )) {
      let state = diagnosed(incident.id);
      state = act(incident.id, state, 'hypothesis', hypothesis.id);
      assert.equal(state.phase, 'hypothesis');
      assert.equal(state.history.at(-1).kind, 'error');
      state = act(incident.id, state, 'fix', solutions[incident.id][1]);
      state = act(incident.id, state, 'verify');
      assert.equal(state.verified, false);
      assert.equal(state.fixed, false);
    }
    for (const fix of incident.fixes.filter((item) => item.id !== solutions[incident.id][1])) {
      let state = diagnosed(incident.id);
      state = act(incident.id, state, 'fix', fix.id);
      assert.equal(state.history.at(-1).kind, 'error');
      assert.ok(state.history.at(-1).text.length > 60);
      assert.equal(state.fixed, false);
      state = act(incident.id, state, 'verify');
      assert.equal(state.verified, false);
    }
  });
}

test('zero lag after skipping backlog does not prove recovery', () => {
  let state = diagnosed('lag-growth');
  state = act('lag-growth', state, 'fix', 'reset-latest');
  assert.equal(state.metrics.lag, 0);
  assert.notEqual(state.flow, 'healthy');
  assert.equal(act('lag-growth', state, 'verify').verified, false);
  state = act('lag-growth', state, 'fix', 'repair-downstream');
  assert.ok(state.metrics.lag > 0, 'replay makes unfinished work visible again');
  assert.equal(act('lag-growth', state, 'verify').verified, true);
});

test('more consumers worsen this downstream bottleneck', () => {
  const before = diagnosed('lag-growth');
  const after = act('lag-growth', before, 'fix', 'scale-consumers');
  assert.ok(after.metrics.lag > before.metrics.lag);
  assert.ok(after.metrics.outRate < before.metrics.outRate);
  assert.equal(after.nodes.external, 'blocked');
  assert.equal(before.nodes.external, 'degraded');
});

test('removing log history requires reset and cannot be repaired by a capacity toggle', () => {
  for (const destructiveFix of ['delete-segments', 'retention-zero']) {
    let state = act('disk-full', diagnosed('disk-full'), 'fix', destructiveFix);
    assert.equal(state.recoveryRequired, true);
    state = act('disk-full', state, 'fix', 'expand-capacity');
    assert.equal(state.fixed, false);
    state = act('disk-full', state, 'verify');
    assert.equal(state.verified, false);
    assert.equal(act('disk-full', state, 'reset').recoveryRequired, false);
  }
});

test('producer idempotence does not reconcile external charges', () => {
  let state = diagnosed('duplicate-charge');
  const initialDuplicates = state.metrics.duplicates;
  state = act('duplicate-charge', state, 'fix', 'producer-idempotence');
  assert.ok(state.metrics.duplicates > initialDuplicates);
  const outstanding = state.metrics.duplicates;
  state = act('duplicate-charge', state, 'fix', 'commit-first');
  assert.equal(
    state.metrics.duplicates,
    outstanding,
    'moving commit cannot erase existing duplicate payments',
  );
  state = act('duplicate-charge', state, 'fix', 'idempotent-reconcile');
  assert.equal(state.metrics.duplicates, outstanding, 'code fix does not erase past effects');
  state = act('duplicate-charge', state, 'verify');
  assert.equal(state.metrics.duplicates, 0);
  assert.match(state.history.at(-1).text, /компенсац/);
});

test('ISR shortcut restores apparent traffic but does not meet the durability requirement', () => {
  let state = act('insufficient-isr', diagnosed('insufficient-isr'), 'fix', 'lower-min-isr');
  assert.equal(state.metrics.isr, 1);
  assert.ok(state.metrics.inRate > 0);
  assert.equal(act('insufficient-isr', state, 'verify').verified, false);
  state = act('insufficient-isr', state, 'fix', 'restore-replicas');
  assert.equal(state.metrics.isr, 3);
  assert.equal(act('insufficient-isr', state, 'verify').verified, true);
});

test('history snapshots are immutable, bounded and deterministically replayable', () => {
  const run = () => {
    let state = createIncidentState('poison-pill');
    for (let i = 0; i < 70; i += 1) state = act('poison-pill', state, 'observe', 'coordinate');
    return state;
  };
  const state = run();
  assert.deepEqual(state, run());
  assert.equal(state.history.length, 40);
  assert.equal(state.observed.length, 1);
  assert.deepEqual(state.history[0], createIncidentState('poison-pill').history[0]);
  const snapshot = structuredClone(state.history[0]);
  state.metrics.lag = 0;
  state.nodes.consumer = 'healthy';
  assert.deepEqual(state.history[0], snapshot);
});

test('malformed requests cannot set verified, score or inject state', () => {
  const initial = createIncidentState('lag-growth');
  const invalid = (input) =>
    assert.throws(() => actIncident('lag-growth', initial, input), {
      code: 'INVALID_INCIDENT_INPUT',
    });
  for (const input of [
    null,
    [],
    {},
    { action: 'finish' },
    { action: 'verify', verified: true },
    { action: 'verify', score: 100 },
    { action: 'verify', state: { fixed: true } },
    { action: 'fix', choice: '__proto__' },
    { action: 'observe', choice: 1 },
    { action: 'verify', choice: 'x' },
  ])
    invalid(input);
  assert.throws(() => createIncidentState('__proto__'), { code: 'INVALID_INCIDENT_INPUT' });
  assert.throws(() => publicIncident('missing'), { code: 'INVALID_INCIDENT_INPUT' });
  assert.throws(() => act('poison-pill', initial, 'verify'), { code: 'INVALID_INCIDENT_INPUT' });
  const noFixEvidence = { ...diagnosed('lag-growth'), fixed: true, fix: null };
  assert.equal(act('lag-growth', noFixEvidence, 'verify').verified, false);
});

test('reset recovers a malformed persisted state without accepting it as solved', () => {
  assert.deepEqual(act('lag-growth', { id: 'broken' }, 'reset'), createIncidentState('lag-growth'));
  assert.throws(() => act('lag-growth', { id: 'broken' }, 'verify'), {
    code: 'INVALID_INCIDENT_INPUT',
  });
});
