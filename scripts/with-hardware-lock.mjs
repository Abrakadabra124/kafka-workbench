import { spawn } from 'node:child_process';
import { acquireHardwareLock } from '../server/hardware-lock.mjs';
const args = process.argv.slice(2);
const wait = args[0] === '--wait';
if (wait) args.shift();
let release;
const deadline = Date.now() + 900000;
while (!release) {
  try {
    release = await acquireHardwareLock();
  } catch (error) {
    if (!wait || error.code !== 'HARDWARE_BUSY' || Date.now() > deadline) throw error;
    if (deadline - Date.now() > 895000)
      console.log('Waiting for the shared trainer hardware lock.');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
try {
  const child = spawn(process.execPath, args, {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  process.exitCode = code ?? 1;
} finally {
  await release();
}
