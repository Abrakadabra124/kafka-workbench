import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRecipe,
  defaultRecipe,
  emptyWorkspaceState,
  evaluateWorkspace,
  createWorkspaceRunner,
} from '../server/workspace.mjs';
import { createStore } from '../server/store.mjs';
import { acquireHardwareLock } from '../server/hardware-lock.mjs';
import { workspaceDocker } from './fixtures/workspace-docker.mjs';

test('Docker Desktop slash labels preserve checkout identity; save is offline and invalid edits cannot block recovery', async () => {
  const states = new Map();
  const fake = workspaceDocker();
  const runner = createWorkspaceRunner({
    hardwareLock: false,
    store: {
      workspace: (id) => states.get(id),
      saveWorkspace: (id, state) => states.set(id, state),
    },
    runCommand: async (args, options) => {
      const r = await fake.runCommand(args, options);
      if (args.includes('ps'))
        r.stdout = JSON.stringify(
          JSON.parse(r.stdout).map((c) => ({
            ...c,
            Labels: `com.docker.compose.project.config_files=${args[4]},desktop.docker.io/ports.scheme=v2,com.docker.compose.service=${c.Service}`,
          })),
        );
      return r;
    },
  });
  assert.equal((await runner.execute('delivery', 'save', defaultRecipe())).ok, true);
  assert.equal(fake.calls.length, 0);
  assert.equal((await runner.execute('delivery', 'prepare')).ok, true);
  assert.equal((await runner.execute('delivery', 'produce')).ok, true);
  assert.equal((await runner.execute('delivery', 'inspect', '{bad json')).ok, true);
  assert.equal((await runner.execute('delivery', 'verify', '{bad json')).state.verified, false);
  assert.equal((await runner.execute('delivery', 'stop', '{bad json')).ok, true);
});

test('recipe validates allowlists, bounded data and booleans without interpreting code', () => {
  const recipe = JSON.parse(defaultRecipe());
  assert.equal(parseRecipe(defaultRecipe()).records.length, 3);
  for (const mutate of [
    (r) => (r.command = 'bash'),
    (r) => (r.records[0].partition = -1),
    (r) => (r.consumer.group = '../../evil'),
    (r) => (r.consumer.commit = 'true'),
    (r) => (r.consumer.maxRecords = 999),
    (r) => (r.records[0].value = 'a\nb'),
    (r) => (r.records = Array(13).fill(r.records[0])),
  ]) {
    const bad = structuredClone(recipe);
    mutate(bad);
    assert.throws(() => parseRecipe(JSON.stringify(bad)));
  }
  recipe.records[0].value = '$(echo innocent) `text` <script>data</script>';
  assert.equal(parseRecipe(JSON.stringify(recipe)).records[0].value, recipe.records[0].value);
});
const rows = [0, 1, 2].map((partition) => ({
  partition,
  offset: 0,
  key: 'key',
  value: `v${partition}`,
}));
const snapshot = {
  partitions: [0, 1, 2].map((partition) => ({
    partition,
    leader: partition + 1,
    end: 1,
    committed: 1,
    replicas: [1, 2, 3],
    isr: [1, 2, 3],
  })),
};
const complete = () => ({
  ...emptyWorkspaceState(),
  ledger: rows,
  reads: [{ group: 'orders', committed: true, records: rows }],
});

test('36 one-record reads retain grading evidence and maximum UTF-8 payloads fit the adapter output bound', async () => {
  const states = new Map();
  const fake = workspaceDocker();
  const runner = createWorkspaceRunner({
    hardwareLock: false,
    store: {
      workspace: (id) => states.get(id),
      saveWorkspace: (id, state) => states.set(id, state),
    },
    runCommand: async (args, options = {}) => {
      const result = await fake.runCommand(args, options);
      if (Buffer.byteLength(result.stdout) > (options.maxOutputBytes ?? 65536))
        return { ...result, outputLimited: true };
      return result;
    },
  });
  const recipe = JSON.parse(defaultRecipe());
  recipe.records = Array.from({ length: 12 }, (_, i) => ({
    partition: i % 3,
    key: `${i}${'я'.repeat(512)}`.slice(0, 512),
    value: '界'.repeat(512),
  }));
  recipe.consumer = { group: 'orders', maxRecords: 1, commit: true };
  assert.equal((await runner.execute('delivery', 'prepare', JSON.stringify(recipe))).ok, true);
  for (let i = 0; i < 3; i++) assert.equal((await runner.execute('delivery', 'produce')).ok, true);
  for (let i = 0; i < 36; i++) assert.equal((await runner.execute('delivery', 'consume')).ok, true);
  const result = await runner.execute('delivery', 'verify');
  assert.equal(result.state.verified, true);
  assert.equal(result.state.reads.length, 24);
  assert.equal(result.state.readEvidence.length, 36);
});
test('independent verifier rejects empty, wrong payload, missing reads, skipped offsets and degraded replicas', () => {
  assert.equal(evaluateWorkspace('delivery', complete(), snapshot, rows).passed, true);
  assert.equal(evaluateWorkspace('delivery', emptyWorkspaceState(), snapshot, rows).passed, false);
  assert.equal(evaluateWorkspace('delivery', complete(), snapshot, rows.slice(1)).passed, false);
  assert.equal(
    evaluateWorkspace(
      'delivery',
      complete(),
      snapshot,
      rows.map((r) => ({ ...r, value: 'wrong' })),
    ).passed,
    false,
  );
  assert.equal(
    evaluateWorkspace('delivery', { ...complete(), reads: [] }, snapshot, rows).passed,
    false,
  );
  for (const change of [{ committed: 0 }, { end: 2 }, { isr: [1, 2] }])
    assert.equal(
      evaluateWorkspace(
        'delivery',
        complete(),
        { partitions: snapshot.partitions.map((p) => ({ ...p, ...change })) },
        rows,
      ).passed,
      false,
    );
  const audit = { ...complete(), reads: [{ group: 'audit', committed: true, records: rows }] };
  assert.equal(evaluateWorkspace('delivery', audit, snapshot, rows).passed, false);
});
test('replay and recovery require evidence of their specific failure, not just a healthy final snapshot', () => {
  const state = complete();
  assert.equal(evaluateWorkspace('replay', state, snapshot, rows).passed, false);
  state.reads.push(
    { group: 'orders', committed: false, records: rows },
    { group: 'orders', committed: false, records: rows },
  );
  assert.equal(evaluateWorkspace('replay', state, snapshot, rows).passed, true);
  assert.equal(evaluateWorkspace('recovery', state, snapshot, rows).passed, false);
  state.faultObserved = true;
  assert.equal(evaluateWorkspace('recovery', state, snapshot, rows).passed, false);
  state.wroteDuringFault = true;
  assert.equal(evaluateWorkspace('recovery', state, snapshot, rows).passed, true);
});
test('drafts and evidence survive reopening SQLite without modifying existing progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kafka-workspace-store-'));
  try {
    let store = createStore(dir);
    store.answer('event-log', 'question', true);
    store.note('event-log', 'keep');
    const progress = store.progress();
    const state = { ...complete(), history: [{ action: 'verify', ok: true }] };
    store.saveWorkspace('delivery', state);
    store.close();
    store = createStore(dir);
    assert.deepEqual(store.workspace('delivery'), state);
    assert.deepEqual(store.progress(), progress);
    store.reset();
    assert.deepEqual(store.workspace('delivery'), state);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('runner rejects forged operations, recipes and foreign ownership before any mutation', async () => {
  const entries = new Map();
  const store = {
    workspace: (id) => entries.get(id),
    saveWorkspace: (id, s) => entries.set(id, s),
  };
  const calls = [];
  const runner = createWorkspaceRunner({
    store,
    hardwareLock: false,
    runCommand: async (args) => {
      calls.push(args);
      return {
        code: 0,
        stdout: JSON.stringify([
          {
            Service: 'broker1',
            Labels: { 'com.docker.compose.project.config_files': 'C:/foreign/compose.yaml' },
          },
        ]),
        stderr: '',
      };
    },
  });
  assert.equal((await runner.execute('delivery', 'shell')).httpStatus, 400);
  assert.equal((await runner.execute('delivery', 'prepare', '{}')).httpStatus, 400);
  assert.equal(calls.length, 0);
  const r = await runner.execute('delivery', 'prepare');
  assert.equal(r.ok, false);
  assert.match(r.error, /другому checkout/u);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('ps'));
  assert.equal(r.state.verified, false);
});
test('cooperative hardware mutex is atomic and releases only its own directory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kafka-mutex-'));
  const path = join(dir, 'trainer-hardware.lock');
  try {
    const release = await acquireHardwareLock(path);
    await assert.rejects(acquireHardwareLock(path), /занято/u);
    await release();
    const again = await acquireHardwareLock(path);
    await again();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
