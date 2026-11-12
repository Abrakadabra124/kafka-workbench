import { spawnSync } from 'node:child_process';
const result = spawnSync(
  process.execPath,
  ['scripts/with-hardware-lock.mjs', '--wait', '--test', 'tests/practice-live.test.mjs'],
  {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    env: { ...process.env, RUN_PRACTICE_LIVE: '1' },
  },
);
process.exitCode = result.status ?? 1;
