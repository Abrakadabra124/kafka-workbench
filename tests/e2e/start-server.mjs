import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createApp } from '../../server/app.mjs';
const dataDir = mkdtempSync(join(tmpdir(), 'kafka-workbench-e2e-'));
const app = createApp({
  dataDir,
  labRunner: {
    actions: ['start', 'topic', 'produce', 'consume', 'inspect', 'stop'],
    status: async () => ({
      available: false,
      running: false,
      status: 'Docker недоступен в изолированной браузерной проверке.',
    }),
    execute: async () => ({
      ok: false,
      output: 'Браузерная проверка не управляет реальным Docker.',
    }),
  },
});
const server = app.listen(4185, '127.0.0.1');
function close() {
  server.close(() => {
    app.locals.close();
    if (dirname(dataDir) === tmpdir() && dataDir.startsWith(join(tmpdir(), 'kafka-workbench-e2e-')))
      rmSync(dataDir, { recursive: true, force: true });
  });
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
