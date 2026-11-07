import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createWorkspaceRunner, defaultRecipe } from '../server/workspace.mjs';
import { runDockerCommand } from '../server/lab.mjs';

test(
  'real three-broker workspace: delivery, replay, broker failure, recovery, negative checks and repeat',
  { skip: process.env.RUN_WORKSPACE_LIVE !== '1', timeout: 1200000 },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kafka-workspace-live-'));
    const store = createStore(dir);
    const runner = createWorkspaceRunner({ store, testMode: true, hardwareLock: false });
    const evidence = [];
    const act = async (id, action, recipe) => {
      const start = Date.now();
      const r = await runner.execute(id, action, recipe ? JSON.stringify(recipe) : undefined);
      console.log(
        `${id}/${action}: ${r.ok ? 'ok' : 'FAILED'} (${Math.round((Date.now() - start) / 1000)}s) ${r.error ?? r.event?.message ?? ''}`,
      );
      evidence.push({ task: id, action, ok: r.ok, error: r.error, event: r.event });
      assert.equal(r.ok, true, `${id}/${action}: ${r.error}`);
      return r;
    };
    try {
      for (const id of ['delivery', 'replay', 'recovery'])
        await t.test(id, async () => {
          for (let attempt = 0; attempt < 2; attempt++) {
            const recipe = JSON.parse(defaultRecipe());
            recipe.consumer.maxRecords = 3;
            await act(id, 'prepare', recipe);
            const premature = await act(id, 'verify');
            assert.equal(premature.state.verified, false);
            if (id === 'recovery') {
              const fault = await act(id, 'fault');
              assert.equal(fault.state.faultObserved, true);
            }
            await act(id, 'produce');
            const first = await act(id, 'consume');
            assert.equal(first.event.result.records.length, 3);
            assert.equal(
              first.state.snapshot.partitions.reduce((n, p) => n + p.lag, 0),
              3,
            );
            if (id === 'replay') {
              const second = await act(id, 'consume');
              const canonical = (r) => r.map((x) => JSON.stringify(x)).sort();
              assert.deepEqual(
                canonical(second.event.result.records),
                canonical(first.event.result.records),
              );
            }
            const negative = await act(id, 'verify');
            assert.equal(negative.state.verified, false);
            if (id === 'recovery') {
              const restored = await act(id, 'recover');
              assert.ok(restored.state.snapshot.partitions.every((p) => p.isr.length === 3));
            }
            recipe.consumer.commit = true;
            await act(id, 'consume', recipe);
            const verified = await act(id, 'verify');
            assert.equal(verified.state.verified, true, JSON.stringify(verified.event.result));
            const onceMore = await act(id, 'consume');
            assert.equal(onceMore.event.result.records.length, 0);
            assert.equal((await act(id, 'verify')).state.verified, true);
            assert.equal(verified.state.attempt, attempt + 1);
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
        'data/workspace-live-evidence.json',
        JSON.stringify({ finishedAt: new Date().toISOString(), evidence }, null, 2),
      );
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
