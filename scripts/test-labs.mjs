import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--test', 'tests/labs.test.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, RUN_LIVE_LABS: '1' },
});
process.exitCode = result.status ?? 1;
