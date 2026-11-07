import { mkdir, writeFile, readFile, unlink, rmdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const hardwareLockPath = fileURLToPath(
  new URL('../../.qa/trainer-hardware.lock', import.meta.url),
);
export async function acquireHardwareLock(path = hardwareLockPath) {
  await mkdir(dirname(path), { recursive: true });
  try {
    await mkdir(path);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw Object.assign(
      new Error(
        'Оборудование занято проверкой другого тренажёра. Повторите после её завершения. Чужой lock не изменён.',
      ),
      { code: 'HARDWARE_BUSY' },
    );
  }
  const owner = {
    owner: 'kafka-workbench',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };
  await writeFile(join(path, 'owner.json'), JSON.stringify(owner));
  return async () => {
    const current = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
    if (current.token !== owner.token || current.pid !== process.pid)
      throw new Error('Hardware lock owner changed.');
    await unlink(join(path, 'owner.json'));
    await rmdir(path);
  };
}
