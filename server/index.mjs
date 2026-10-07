import { resolve } from 'node:path';
import { createApp } from './app.mjs';

const port = Number(process.env.PORT ?? 4184);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('PORT must be an integer from 1 to 65535.');
const app = createApp({
  ...(process.env.DATA_DIR ? { dataDir: resolve(process.env.DATA_DIR) } : {}),
});
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Kafka Workbench: http://127.0.0.1:${port}`);
});
server.on('error', (error) => {
  app.locals.close();
  console.error(
    error.code === 'EADDRINUSE' ? `Порт ${port} уже занят.` : 'Не удалось запустить сервер.',
  );
  process.exitCode = 1;
});
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    app.locals.close();
  });
  setTimeout(() => {
    server.closeAllConnections();
    app.locals.close();
  }, 5000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
