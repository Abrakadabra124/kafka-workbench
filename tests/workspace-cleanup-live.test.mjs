import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.mjs';
import { createWorkspaceRunner } from '../server/workspace.mjs';
import { runDockerCommand } from '../server/lab.mjs';

test(
  'real workspace cleanup removes every captured image volume and is safe to repeat',
  {
    skip: process.env.RUN_WORKSPACE_CLEANUP_LIVE !== '1',
    timeout: 300000,
  },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kafka-cleanup-check-'));
    const store = createStore(directory);
    const runner = createWorkspaceRunner({ store, testMode: true, hardwareLock: false });
    const evidence = {
      capturedAt: new Date().toISOString(),
      commands: [],
      containers: [],
      volumes: [],
      stop: null,
      repeat: null,
    };
    const inspect = async (args) => {
      const result = await runDockerCommand(args);
      evidence.commands.push({ args, ...result });
      assert.equal(result.code, 0, result.stderr);
      assert.ok(!result.timedOut && !result.outputLimited);
      return result.stdout;
    };
    try {
      await inspect(['version']);
      await inspect(['compose', 'version']);
      const prepared = await runner.execute('delivery', 'prepare');
      assert.equal(prepared.ok, true, prepared.error);
      // Recreate one owned service so Compose reattaches its previous anonymous
      // volumes by Source name, matching the leftover-volume failure mode.
      const recreateArgs = [
        'compose',
        '--project-name',
        'kafka-workbench-workspace-test',
        '--file',
        fileURLToPath(new URL('../labs/workspace.yaml', import.meta.url)),
        'up',
        '--detach',
        '--wait',
        '--no-deps',
        '--force-recreate',
        'broker1',
      ];
      evidence.recreate = await runDockerCommand(recreateArgs, {
        timeoutMs: 120000,
        env: {
          ...process.env,
          KAFKA_WORKSPACE_SUBNET: process.env.KAFKA_WORKSPACE_TEST_SUBNET ?? '10.254.244.16/28',
        },
      });
      assert.equal(evidence.recreate.code, 0, evidence.recreate.stderr);
      assert.ok(!evidence.recreate.timedOut && !evidence.recreate.outputLimited);
      const ids = (
        await inspect([
          'ps',
          '-aq',
          '--filter',
          'label=com.docker.compose.project=kafka-workbench-workspace-test',
        ])
      )
        .trim()
        .split(/\s+/u)
        .filter(Boolean);
      assert.equal(ids.length, 3);
      evidence.containers = JSON.parse(await inspect(['inspect', ...ids])).map((container) => ({
        id: container.Id,
        name: container.Name,
        labels: container.Config.Labels,
        mounts: container.Mounts,
        declaredVolumes: container.Config.Volumes,
        binds: container.HostConfig.Binds,
        mountsConfig: container.HostConfig.Mounts,
        volumesFrom: container.HostConfig.VolumesFrom,
        image: container.Image,
      }));
      const names = [
        ...new Set(
          evidence.containers.flatMap((container) =>
            container.mounts.filter((mount) => mount.Type === 'volume').map((mount) => mount.Name),
          ),
        ),
      ];
      assert.ok(
        names.length > 0,
        'This image declares volumes; cleanup must actually exercise them.',
      );
      evidence.volumes = JSON.parse(await inspect(['volume', 'inspect', ...names]));
      // Keep the actual Compose rendering alongside inspect IDs: recent versions
      // abbreviate IDs in JSON unless --no-trunc is explicitly requested.
      const composePs = [
        'compose',
        '--project-name',
        'kafka-workbench-workspace-test',
        '--file',
        fileURLToPath(new URL('../labs/workspace.yaml', import.meta.url)),
        'ps',
        '--all',
        '--format',
        'json',
      ];
      evidence.composePs = await inspect(composePs);
      evidence.composePsFull = await inspect([...composePs, '--no-trunc']);
      assert.ok(
        evidence.containers.some((container) =>
          container.mountsConfig?.some(
            (mount) => mount.Type === 'volume' && names.includes(mount.Source),
          ),
        ),
        'The preflight must exercise an inherited volume with an explicit Source.',
      );
      evidence.stop = await runner.execute('delivery', 'stop');
      const remainingContainers = await inspect([
        'ps',
        '-aq',
        '--filter',
        'label=com.docker.compose.project=kafka-workbench-workspace-test',
      ]);
      const remainingNetworks = await inspect([
        'network',
        'ls',
        '--filter',
        'label=com.docker.compose.project=kafka-workbench-workspace-test',
        '--format',
        '{{.ID}}',
      ]);
      const remainingVolumes = new Set(
        (await inspect(['volume', 'ls', '--format', '{{.Name}}'])).trim().split(/\r?\n/u),
      );
      evidence.retainedVolumes = names.filter((name) => remainingVolumes.has(name));
      assert.equal(evidence.stop.ok, true, evidence.stop.error);
      assert.equal(remainingContainers.trim(), '');
      assert.equal(remainingNetworks.trim(), '');
      assert.deepEqual(
        evidence.retainedVolumes,
        [],
        'All volumes captured from the three owned containers must be gone.',
      );
      evidence.repeat = await runner.execute('delivery', 'stop');
      assert.equal(evidence.repeat.ok, true, evidence.repeat.error);
    } finally {
      if (!evidence.stop?.ok) evidence.finalStop = await runner.execute('delivery', 'stop');
      mkdirSync('data', { recursive: true });
      writeFileSync('data/workspace-cleanup-evidence.json', JSON.stringify(evidence, null, 2));
      store.close();
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('kafka-cleanup-check-'));
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
