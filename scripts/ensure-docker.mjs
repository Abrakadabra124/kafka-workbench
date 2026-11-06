// Local Windows prerequisite check, always launched under with-hardware-lock.mjs.
import { spawn } from 'node:child_process';
import { runDockerCommand } from '../server/lab.mjs';
let result = await runDockerCommand(['version', '--format', '{{.Server.Version}}'], {
  timeoutMs: 5000,
});
if (result.code === 0) {
  console.log('Docker ready:', result.stdout.trim());
} else {
  if (process.platform !== 'win32')
    throw new Error('Start Docker Engine before running live labs.');
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "Start-Process -FilePath (Join-Path $env:LOCALAPPDATA 'Programs/DockerDesktop/Docker Desktop.exe') -WindowStyle Hidden",
    ],
    { shell: false, windowsHide: true, stdio: 'inherit' },
  );
  await new Promise((res, rej) => {
    child.on('error', rej);
    child.on('close', res);
  });
  let ready = false;
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    result = await runDockerCommand(['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 3000,
    });
    if (result.code === 0) {
      ready = true;
      console.log('Docker ready:', result.stdout.trim());
      break;
    }
  }
  if (!ready) throw new Error('Docker Desktop has not become ready.');
}
