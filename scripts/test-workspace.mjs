import { spawnSync } from 'node:child_process';
const browser = process.argv.includes('--browser');
const target = browser
  ? ['node_modules/@playwright/test/cli.js', 'test', 'tests/e2e/workspace-real.spec.mjs']
  : ['--test', 'tests/workspace-live.test.mjs'];
const result = spawnSync(
  process.execPath,
  ['scripts/with-hardware-lock.mjs', '--wait', ...target],
  {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
    env: { ...process.env, [browser ? 'RUN_WORKSPACE_BROWSER' : 'RUN_WORKSPACE_LIVE']: '1' },
  },
);
process.exitCode = result.status ?? 1;
