import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createWorkspaceRunner } from '../server/workspace.mjs';
import { practiceTasks } from '../server/practice-workspace.mjs';
import { runDockerCommand } from '../server/lab.mjs';

test(
  'real practice: quarantine, ISR write rejection and retention recovery, negative decisions and reset',
  { skip: process.env.RUN_PRACTICE_LIVE !== '1', timeout: 1200000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'kafka-practice-'));
    const store = createStore(directory);
    const runner = createWorkspaceRunner({ store, testMode: true, hardwareLock: false });
    const evidence = [];
    async function action(id, kind) {
      const started = Date.now();
      const result = await runner.execute(id, kind);
      console.log(
        `${id}/${kind}: ${result.ok ? 'ok' : 'FAIL'} ${Math.round((Date.now() - started) / 1000)}s ${result.error ?? result.event?.message ?? ''}`,
      );
      evidence.push({ id, kind, ok: result.ok, event: result.event, error: result.error });
      assert.equal(result.ok, true, result.error);
      return result;
    }
    try {
      for (const task of practiceTasks)
        await t.test(task.id, async () => {
          for (let repeat = 0; repeat < 2; repeat++) {
            await action(task.id, 'prepare');
            assert.equal(
              (await runner.execute(task.id, 'recover')).ok,
              false,
              'repair before fault is rejected',
            );
            assert.equal((await action(task.id, 'verify')).state.verified, false);
            const fault = await action(task.id, 'fault');
            assert.equal(fault.state.faultObserved, true, JSON.stringify(fault.event));
            await action(task.id, 'inspect');
            await action(task.id, 'retry');
            assert.equal(
              (await action(task.id, 'verify')).state.verified,
              false,
              'second incorrect strategy must fail',
            );
            if (task.id === 'poison-quarantine') {
              await action(task.id, 'interrupt');
              assert.equal(
                (await action(task.id, 'verify')).state.verified,
                false,
                'quarantine before commit is incomplete',
              );
            }
            await action(task.id, 'unsafe');
            assert.equal(
              (await action(task.id, 'verify')).state.verified,
              false,
              'shortcut must never pass',
            );
            await action(task.id, 'recover');
            const verified = await action(task.id, 'verify');
            assert.equal(verified.state.verified, true, JSON.stringify(verified.event.result));
            await action(task.id, 'recover');
            assert.equal(
              (await action(task.id, 'verify')).state.verified,
              true,
              'safe repair must be repeatable without duplicate effects',
            );
            assert.equal(verified.state.attempt, repeat + 1);
          }
        });
    } finally {
      const ownedIds = await runDockerCommand([
        'ps',
        '-aq',
        '--filter',
        'label=com.docker.compose.project=kafka-workbench-workspace-test',
      ]);
      const ids = ownedIds.stdout.trim().split(/\s+/u).filter(Boolean);
      const details = ids.length ? await runDockerCommand(['inspect', ...ids]) : { stdout: '[]' };
      const volumeIds = [
        ...new Set(
          JSON.parse(details.stdout).flatMap((c) =>
            c.Mounts.filter((m) => m.Type === 'volume').map((m) => m.Name),
          ),
        ),
      ];
      const stopped = await runner.execute('delivery', 'stop');
      evidence.push({ action: 'stop', ok: stopped.ok, error: stopped.error });
      const remaining = await runDockerCommand([
        'ps',
        '-a',
        '--filter',
        'label=com.docker.compose.project=kafka-workbench-workspace-test',
        '--format',
        '{{.ID}}',
      ]);
      assert.equal(stopped.ok, true, stopped.error);
      assert.equal(remaining.stdout.trim(), '');
      const networks = await runDockerCommand([
        'network',
        'ls',
        '--filter',
        'label=com.docker.compose.project=kafka-workbench-workspace-test',
        '--format',
        '{{.ID}}',
      ]);
      assert.equal(networks.stdout.trim(), '');
      const volumeList = await runDockerCommand(['volume', 'ls', '--format', '{{.Name}}']);
      const retained = new Set(volumeList.stdout.trim().split(/\r?\n/u));
      assert.ok(
        volumeIds.every((id) => !retained.has(id)),
        'All captured anonymous volumes must be removed.',
      );
      evidence.push({
        action: 'resource-cleanup',
        containers: 0,
        networks: 0,
        removedVolumes: volumeIds.length,
      });
      mkdirSync('data', { recursive: true });
      writeFileSync(
        'data/practice-live-evidence.json',
        JSON.stringify({ finishedAt: new Date().toISOString(), evidence }, null, 2),
      );
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
