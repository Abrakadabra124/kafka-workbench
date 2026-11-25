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

test('cleanup requests full Compose IDs before matching container inspection and supports repeat stop', async () => {
  const states = new Map();
  const fake = workspaceDocker();
  const runner = createWorkspaceRunner({
    hardwareLock: false,
    store: {
      workspace: (id) => states.get(id),
      saveWorkspace: (id, state) => states.set(id, state),
    },
    runCommand: fake.runCommand,
  });
  assert.equal((await runner.execute('delivery', 'prepare')).ok, true);
  const stopped = await runner.execute('delivery', 'stop');
  assert.equal(stopped.ok, true, stopped.error);
  const inspected = fake.calls.find(({ args }) => args[0] === 'inspect');
  assert.ok(inspected, 'cleanup must inspect the actual containers before removal');
  assert.equal(inspected.args.slice(3).length, 3);
  assert.ok(inspected.args.slice(3).every((id) => /^[a-f0-9]{64}$/u.test(id)));
  const repeated = await runner.execute('delivery', 'stop');
  assert.equal(repeated.ok, true, repeated.error);
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

test('ownership inspection timeout fails closed before mutations and a fresh request can recover', async () => {
  const states = new Map();
  const fake = workspaceDocker();
  let timedOut = true;
  const runner = createWorkspaceRunner({
    hardwareLock: false,
    store: { workspace: (id) => states.get(id), saveWorkspace: (id, s) => states.set(id, s) },
    runCommand: async (args, options) => {
      if (timedOut) {
        fake.calls.push({ args, options });
        return { code: -1, timedOut: true, stdout: '', stderr: '' };
      }
      return fake.runCommand(args, options);
    },
  });
  const rejected = await runner.execute('delivery', 'prepare');
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /принадлежность/);
  assert.equal(rejected.state.prepared, false);
  assert.ok(fake.calls.every((c) => c.args.includes('ps')));
  timedOut = false;
  assert.equal((await runner.execute('delivery', 'prepare')).ok, true);
});

// Docker is the external boundary. Both Compose cleanup paths deliberately leave
// the captured volume behind, matching the second observed CI failure.
const cleanupContainer = '1'.repeat(64);
const cleanupVolume = 'a'.repeat(64);
const unrelatedVolume = 'b'.repeat(64);
const cleanupImage = `sha256:${'c'.repeat(64)}`;
function cleanupFixture(settings = {}) {
  const calls = [];
  const volumes = new Set([cleanupVolume, unrelatedVolume, 'named-data']);
  const resources = { containers: true, network: true };
  const states = new Map();
  const metadata = {
    Name: cleanupVolume,
    Driver: 'local',
    Scope: 'local',
    CreatedAt: '2026-11-25T06:00:00Z',
    Mountpoint: '/var/lib/docker/volumes/owned/_data',
    Labels: settings.legacy ? null : { 'com.docker.volume.anonymous': '' },
    Options: null,
  };
  let composePath;
  const mutate = (args) =>
    (args[0] === 'compose' && ['rm', 'down'].includes(args[5])) ||
    (args[0] === 'volume' && args[1] === 'rm');
  const runner = createWorkspaceRunner({
    hardwareLock: false,
    store: {
      workspace: (id) => states.get(id),
      saveWorkspace: (id, state) => states.set(id, state),
    },
    runCommand: async (args) => {
      calls.push(args);
      const ok = (data = '') => ({
        code: 0,
        stdout: typeof data === 'string' ? data : JSON.stringify(data),
        stderr: '',
      });
      if (args[0] === 'compose') {
        assert.equal(args[2], 'kafka-workbench-workspace');
        composePath = args[4];
        if (args[5] === 'ps')
          return ok(
            resources.containers
              ? [
                  {
                    ID: settings.badId ? '--all' : cleanupContainer,
                    Service: 'broker1',
                    State: 'running',
                    Labels: {
                      'com.docker.compose.project.config_files': settings.foreign
                        ? '/foreign/compose.yaml'
                        : composePath,
                    },
                  },
                ]
              : [],
          );
        if (['rm', 'down'].includes(args[5])) {
          resources.containers = false;
          if (args[5] === 'down') resources.network = false;
          return ok();
        }
      }
      if (args[0] === 'inspect') {
        assert.deepEqual(args.slice(1), ['--type', 'container', cleanupContainer]);
        if (settings.inspectFails) return { code: 1, stdout: '', stderr: 'inspection unavailable' };
        const detail = {
          Id: cleanupContainer,
          Image: cleanupImage,
          Config: {
            Labels: {
              'com.docker.compose.project': settings.foreignInspect
                ? 'foreign-project'
                : 'kafka-workbench-workspace',
              'com.docker.compose.project.config_files': composePath,
              'com.docker.compose.service': 'broker1',
            },
          },
          HostConfig: {
            Binds: settings.bind ? ['/host:/data'] : null,
            VolumesFrom: null,
            Mounts: settings.inherited
              ? [{ Type: 'volume', Source: cleanupVolume, Target: '/data' }]
              : [],
          },
          Mounts: [
            {
              Type: 'volume',
              Name: settings.named ? 'named-data' : cleanupVolume,
              Destination: settings.wrongDestination ? '/unexpected' : '/data',
            },
          ],
        };
        return ok(
          settings.partialInspect ? [] : settings.duplicateInspect ? [detail, detail] : [detail],
        );
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        assert.deepEqual(args.slice(2), [cleanupImage]);
        return ok([{ Id: cleanupImage, Config: { Volumes: { '/data': {} } } }]);
      }
      if (args[0] === 'volume' && args[1] === 'inspect') {
        assert.deepEqual(args.slice(2), [cleanupVolume]);
        if (settings.volumeInspectFails)
          return { code: 1, stdout: '', stderr: 'volume inspection unavailable' };
        return ok([
          {
            ...metadata,
            ...(settings.replaced && !resources.containers
              ? { CreatedAt: '2026-11-25T07:00:00Z' }
              : {}),
          },
        ]);
      }
      if (args[0] === 'ps') {
        assert.deepEqual(args.slice(1), [
          '--all',
          '--no-trunc',
          '--filter',
          `volume=${cleanupVolume}`,
          '--format',
          '{{.ID}}',
        ]);
        if (settings.refsFail)
          return { code: 1, stdout: '', stderr: 'reference inspection unavailable' };
        if (settings.shared || (settings.lateShared && !resources.containers))
          return ok(`${cleanupContainer}\n${'d'.repeat(64)}\n`);
        return ok(resources.containers ? `${cleanupContainer}\n` : '');
      }
      if (args[0] === 'volume' && args[1] === 'ls') {
        assert.deepEqual(args.slice(2), [
          '--filter',
          `name=${cleanupVolume}`,
          '--format',
          '{{.Name}}',
        ]);
        return ok(volumes.has(cleanupVolume) ? `${cleanupVolume}\n` : '');
      }
      if (args[0] === 'volume' && args[1] === 'rm') {
        assert.deepEqual(
          args.slice(2),
          [cleanupVolume],
          'only captured names, never force or prune',
        );
        if (settings.removeFails)
          return { code: 1, stdout: '', stderr: 'volume removal unavailable' };
        if (!settings.removeLies) volumes.delete(cleanupVolume);
        return ok(cleanupVolume);
      }
      throw new Error(`Unexpected cleanup command: ${args}`);
    },
  });
  return { runner, calls, volumes, resources, mutate };
}

test('stop verifies and removes only captured anonymous image volumes left by Compose, then repeats safely', async () => {
  const { runner, volumes, resources } = cleanupFixture({ inherited: true });
  const stopped = await runner.execute('delivery', 'stop');
  assert.equal(stopped.ok, true, stopped.error);
  assert.equal(
    volumes.has(cleanupVolume),
    false,
    'successful Compose cleanup can retain inherited anonymous volumes',
  );
  assert.deepEqual([...volumes].sort(), [unrelatedVolume, 'named-data'].sort());
  assert.deepEqual(resources, { containers: false, network: false });
  const repeated = await runner.execute('delivery', 'stop');
  assert.equal(repeated.ok, true, repeated.error);
  assert.deepEqual([...volumes].sort(), [unrelatedVolume, 'named-data'].sort());
});

test('old Docker image-created volumes without an anonymous label are accepted only without explicit mounts', async () => {
  const direct = cleanupFixture({ legacy: true });
  assert.equal((await direct.runner.execute('delivery', 'stop')).ok, true);
  assert.equal(direct.volumes.has(cleanupVolume), false);
  const ambiguous = cleanupFixture({ legacy: true, inherited: true });
  assert.equal((await ambiguous.runner.execute('delivery', 'stop')).ok, false);
  assert.equal(ambiguous.calls.some(ambiguous.mutate), false);
});

for (const invalid of [
  'foreign',
  'foreignInspect',
  'badId',
  'inspectFails',
  'partialInspect',
  'duplicateInspect',
  'bind',
  'named',
  'wrongDestination',
  'volumeInspectFails',
  'shared',
  'refsFail',
]) {
  test(`stop refuses ${invalid} before deleting containers or volumes`, async () => {
    const fixture = cleanupFixture({ [invalid]: true });
    const stopped = await fixture.runner.execute('delivery', 'stop');
    assert.equal(stopped.ok, false);
    assert.equal(fixture.calls.some(fixture.mutate), false, stopped.error);
    assert.equal(fixture.volumes.has(cleanupVolume), true);
    assert.deepEqual(fixture.resources, { containers: true, network: true });
  });
}

for (const invalid of ['lateShared', 'replaced']) {
  test(`stop refuses ${invalid} after down and does not explicitly delete the captured volume`, async () => {
    const fixture = cleanupFixture({ [invalid]: true });
    const stopped = await fixture.runner.execute('delivery', 'stop');
    assert.equal(stopped.ok, false);
    assert.equal(
      fixture.calls.some((args) => args[0] === 'volume' && args[1] === 'rm'),
      false,
    );
    assert.equal(fixture.volumes.has(cleanupVolume), true);
  });
}

test('stop verifies actual volume absence even when volume rm returns success', async () => {
  const fixture = cleanupFixture({ removeLies: true });
  const stopped = await fixture.runner.execute('delivery', 'stop');
  assert.equal(stopped.ok, false);
  assert.equal(fixture.volumes.has(cleanupVolume), true);
});

test('a failed volume removal retains its captured manifest for a safe retry in the same runner', async () => {
  const settings = { removeFails: true };
  const fixture = cleanupFixture(settings);
  assert.equal((await fixture.runner.execute('delivery', 'stop')).ok, false);
  assert.equal(fixture.volumes.has(cleanupVolume), true);
  assert.equal(fixture.resources.containers, false);
  settings.removeFails = false;
  const retried = await fixture.runner.execute('delivery', 'stop');
  assert.equal(retried.ok, true, retried.error);
  assert.equal(fixture.volumes.has(cleanupVolume), false);
});
