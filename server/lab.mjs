import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const composeFile = fileURLToPath(new URL('../labs/compose.yaml', import.meta.url));
const bootstrap = ['--bootstrap-server', 'broker:9092'];
const actions = Object.freeze(['start', 'topic', 'produce', 'consume', 'inspect', 'stop']);
export const sampleRecords = Object.freeze([
  'customer-42|{"orderId":"ORD-101","amount":1290}',
  'customer-7|{"orderId":"ORD-102","amount":780}',
  'customer-42|{"orderId":"ORD-103","amount":2450}',
]);

// The executable and every argument come from this module, never from an HTTP request.
export function runDockerCommand(
  args,
  { input, timeoutMs = 30000, maxOutputBytes = 65536, spawnProcess = spawn } = {},
) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let outputLimited = false;
    let settled = false;
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    const child = spawnProcess('docker', args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      stdout += decoders.stdout.end();
      stderr += decoders.stderr.end();
      resolve({
        code: code ?? -1,
        stdout,
        stderr: error ? `${stderr}\n${error}` : stderr,
        timedOut,
        outputLimited,
      });
    };
    let killTimer;
    const abort = () => {
      child.kill();
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(-1);
      }, 2000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, timeoutMs);
    const collect = (stream) => (chunk) => {
      const remaining = Math.max(0, maxOutputBytes - bytes);
      bytes += chunk.length;
      // Docker may split a UTF-8 path or message across arbitrary pipe chunks.
      const text = decoders[stream].write(chunk.subarray(0, remaining));
      if (stream === 'stdout') stdout += text;
      else stderr += text;
      if (bytes > maxOutputBytes && !outputLimited) {
        outputLimited = true;
        abort();
      }
    };
    child.stdout.on('data', collect('stdout'));
    child.stderr.on('data', collect('stderr'));
    child.on('error', (error) =>
      finish(
        -1,
        error.code === 'ENOENT' ? 'Docker CLI не найден.' : 'Не удалось запустить Docker CLI.',
      ),
    );
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => {}); // Docker may exit before accepting stdin.
    child.stdin.end(input);
  });
}

function outputOf(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function containersFrom(text) {
  if (!text.trim()) return [];
  try {
    const json = JSON.parse(text);
    return Array.isArray(json) ? json : [json];
  } catch {
    return text
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
  }
}

function offsetTotal(text) {
  const lines = text.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length !== 3 || !lines.every((line) => /^orders:[0-2]:\d+$/u.test(line))) return null;
  if (new Set(lines.map((line) => line.split(':')[1])).size !== 3) return null;
  return lines.reduce((sum, line) => sum + Number(line.split(':')[2]), 0);
}

export function createLabRunner({ runCommand = runDockerCommand, testMode = false } = {}) {
  // A separate, fixed namespace prevents verification from deleting the learner's lab.
  // This trusted constructor option is never exposed through the HTTP API.
  const projectName = testMode ? 'kafka-workbench-lab-test' : 'kafka-workbench-lab';
  const composeArgs = ['compose', '--project-name', projectName, '--file', composeFile];
  let busy = false;
  let currentAction = null;
  let lastState = { available: false, running: false, status: 'not-checked' };
  let lastCheckedAt = 0;
  let statusPending;
  const command = (args, options) => runCommand(args, options);
  const compose = (args, options) => command([...composeArgs, ...args], options);
  const kafka = (script, args = [], options) =>
    compose(
      ['exec', '-T', 'broker', `/opt/kafka/bin/${script}.sh`, ...bootstrap, ...args],
      options,
    );
  const checked = async (promise) => {
    const result = await promise;
    if (result.timedOut)
      throw new Error(
        'Время ожидания истекло. Состояние Docker могло измениться; обновите статус или остановите лабораторию.\n' +
          outputOf(result),
      );
    if (result.outputLimited)
      throw new Error('Операция остановлена: вывод превысил 64 КБ.\n' + outputOf(result));
    if (result.code !== 0)
      throw new Error(outputOf(result) || 'Docker завершил операцию с ошибкой.');
    return result;
  };
  const topicDescription = async () => {
    const result = await checked(kafka('kafka-topics', ['--describe', '--topic', 'orders']));
    if (
      !/Topic:\s+orders\b/u.test(result.stdout) ||
      !/PartitionCount:\s*3\b/u.test(result.stdout)
    ) {
      throw new Error(
        'Не удалось подтвердить topic orders с тремя партициями.\n' + outputOf(result),
      );
    }
    return result.stdout.trim();
  };
  const offsets = async () => {
    const result = await checked(kafka('kafka-get-offsets', ['--topic', 'orders', '--time', '-1']));
    if (offsetTotal(result.stdout) === null)
      throw new Error('Не удалось проверить offsets всех трёх партиций.\n' + outputOf(result));
    return result;
  };
  const verifyOwnership = async () => {
    const result = await checked(compose(['ps', '--all', '--format', 'json'], { timeoutMs: 5000 }));
    for (const container of containersFrom(result.stdout)) {
      const labels =
        typeof container.Labels === 'object'
          ? container.Labels
          : Object.fromEntries(
              String(container.Labels ?? '')
                .split(/,(?=[\w.-]+=)/u)
                .map((label) => {
                  const separator = label.indexOf('=');
                  return [label.slice(0, separator), label.slice(separator + 1)];
                }),
            );
      const source = labels['com.docker.compose.project.config_files'];
      const normalize = (path) =>
        process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
      if (!source || normalize(source) !== normalize(composeFile)) {
        throw new Error(
          `Проект ${projectName} запущен из другого checkout. Управляйте им из исходного приложения; эти контейнеры не изменены.`,
        );
      }
    }
  };
  async function readStatus() {
    const daemon = await command(['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 5000,
    });
    if (daemon.code !== 0 || daemon.timedOut || !daemon.stdout.trim()) {
      return {
        available: false,
        running: false,
        status: 'Docker недоступен. Запустите Docker Desktop или Docker Engine.',
      };
    }
    const result = await compose(['ps', '--all', '--format', 'json'], { timeoutMs: 5000 });
    if (result.code !== 0 || result.timedOut)
      return { available: false, running: false, status: 'Docker Compose недоступен.' };
    try {
      const broker = containersFrom(result.stdout).find(
        (container) => container.Service === 'broker',
      );
      const running = broker?.State === 'running';
      return {
        available: true,
        running,
        status: !broker
          ? 'stopped'
          : running && broker.Health === 'healthy'
            ? 'ready'
            : broker.Health || broker.State || 'unknown',
      };
    } catch {
      return {
        available: true,
        running: false,
        status: 'Не удалось разобрать состояние контейнера. Повторите проверку.',
      };
    }
  }
  async function status() {
    if (busy) return { ...lastState, status: `Выполняется: ${currentAction}` };
    if (Date.now() - lastCheckedAt < 1500) return lastState;
    statusPending ??= readStatus()
      .then((result) => {
        lastState = result;
        lastCheckedAt = Date.now();
        return result;
      })
      .finally(() => {
        statusPending = undefined;
      });
    return statusPending;
  }
  async function execute(action) {
    if (!actions.includes(action))
      return { ok: false, httpStatus: 400, output: 'Неизвестная операция лаборатории.' };
    if (busy)
      return {
        ok: false,
        httpStatus: 409,
        output: 'Дождитесь завершения текущей операции лаборатории.',
      };
    busy = true;
    currentAction = action;
    const transcript = [];
    try {
      await verifyOwnership();
      if (action === 'start') {
        const result = await checked(
          compose(['up', '-d', '--quiet-pull', '--wait', '--wait-timeout', '120'], {
            timeoutMs: 240000,
          }),
        );
        transcript.push(outputOf(result));
        await checked(kafka('kafka-topics', ['--list']));
        transcript.push(
          'Готовность брокера проверена запросом metadata. KRaft, один брокер; это учебная среда без отказоустойчивости.',
        );
      } else if (action === 'stop') {
        transcript.push(
          outputOf(
            await checked(compose(['down', '--volumes', '--timeout', '15'], { timeoutMs: 45000 })),
          ),
        );
        const remaining = await checked(
          compose(['ps', '--all', '--format', 'json'], { timeoutMs: 5000 }),
        );
        if (containersFrom(remaining.stdout).length)
          throw new Error('После остановки остались контейнеры учебного проекта.');
        transcript.push(
          `Контейнеры ${projectName} удалены. Учебные сообщения удалены; прогресс уроков сохранён.`,
        );
      } else if (action === 'topic') {
        transcript.push(
          outputOf(
            await checked(
              kafka('kafka-topics', [
                '--create',
                '--if-not-exists',
                '--topic',
                'orders',
                '--partitions',
                '3',
                '--replication-factor',
                '1',
              ]),
            ),
          ),
        );
        transcript.push(await topicDescription());
        transcript.push(
          'Проверено: orders существует, число партиций = 3. Повторная операция не создаёт новый topic.',
        );
      } else if (action === 'produce') {
        await topicDescription();
        const before = offsetTotal((await offsets()).stdout);
        await checked(
          kafka(
            'kafka-console-producer',
            [
              '--topic',
              'orders',
              '--reader-property',
              'parse.key=true',
              '--reader-property',
              'key.separator=|',
              '--command-property',
              'acks=all',
              '--command-property',
              'enable.idempotence=true',
            ],
            { input: sampleRecords.join('\n') + '\n', timeoutMs: 30000 },
          ),
        );
        const afterResult = await offsets();
        const after = offsetTotal(afterResult.stdout);
        if (after - before !== 3)
          throw new Error(
            `Producer завершился, но прирост log end offsets = ${after - before}; ожидалось 3.`,
          );
        transcript.push(
          ...sampleRecords,
          '',
          afterResult.stdout.trim(),
          `Проверено: суммарный log end offset вырос с ${before} до ${after}. Повтор Produce добавляет ещё 3 записи.`,
        );
      } else if (action === 'consume') {
        await topicDescription();
        const result = await checked(
          kafka(
            'kafka-console-consumer',
            [
              '--topic',
              'orders',
              '--group',
              'workbench',
              '--from-beginning',
              '--max-messages',
              '3',
              '--timeout-ms',
              '10000',
              '--formatter-property',
              'print.key=true',
              '--formatter-property',
              'key.separator=|',
              '--command-property',
              'auto.commit.interval.ms=100',
            ],
            { timeoutMs: 30000 },
          ),
        );
        const records = result.stdout.split(/\r?\n/u).filter(Boolean);
        if (records.some((record) => !sampleRecords.includes(record)) || records.length > 3)
          throw new Error(
            'Прочитанные записи не совпадают с контрольными учебными сообщениями.\n' +
              outputOf(result),
          );
        const exceptions =
          result.stderr.match(/\b(?:[\w$]+\.)+[\w$]*(?:Exception|Error)\b/gu) ?? [];
        if (
          exceptions.some((name) => name !== 'org.apache.kafka.common.errors.TimeoutException') ||
          (/\bERROR\b/u.test(result.stderr) && !exceptions.length)
        ) {
          throw new Error(
            'Consumer сообщил об ошибке, несмотря на код завершения.\n' + outputOf(result),
          );
        }
        if (!records.length && !/Processed a total of 0 messages/u.test(result.stderr))
          throw new Error(
            'Consumer завершился без подтверждённого количества сообщений.\n' + outputOf(result),
          );
        // Kafka's console consumer can exit with code 0 after a receive exception.
        // Verify the broker again and establish an empty group's lag independently.
        await topicDescription();
        if (!records.length) {
          const end = offsetTotal((await offsets()).stdout);
          if (end > 0) {
            const group = await checked(
              kafka('kafka-consumer-groups', ['--describe', '--group', 'workbench']),
            );
            const rows = [
              ...group.stdout.matchAll(
                /^workbench\s+orders\s+([0-2])\s+(\d+)\s+(\d+)\s+(\d+)\s/gmu,
              ),
            ];
            if (
              rows.length !== 3 ||
              new Set(rows.map((row) => row[1])).size !== 3 ||
              rows.some((row) => Number(row[4]) !== 0)
            ) {
              throw new Error(
                'Consumer не прочитал записи, но нулевой lag группы не подтверждён.\n' +
                  outputOf(group),
              );
            }
          }
        }
        transcript.push(
          records.length
            ? records.join('\n')
            : 'Новых записей для группы workbench нет. Выполните Produce и повторите чтение.',
        );
        transcript.push(
          `Проверено содержимое ${records.length} записей. Группа: workbench. --from-beginning применяется только при отсутствии сохранённого offset.`,
        );
      } else if (action === 'inspect') {
        transcript.push(await topicDescription(), '', (await offsets()).stdout.trim());
        const group = await kafka('kafka-consumer-groups', ['--describe', '--group', 'workbench']);
        if (group.timedOut || group.outputLimited)
          throw new Error('Не удалось завершить проверку группы workbench.');
        if (group.code !== 0 && !/does not exist/u.test(outputOf(group)))
          throw new Error(outputOf(group));
        transcript.push('', outputOf(group) || 'Группа workbench пока не сохранила offsets.');
      }
      lastState = await readStatus();
      lastCheckedAt = Date.now();
      return {
        ok: true,
        output: transcript.filter(Boolean).join('\n').slice(0, 65536),
        status: lastState.status,
      };
    } catch (error) {
      lastCheckedAt = 0;
      lastState = { ...lastState, status: 'Состояние требует повторной проверки.' };
      return {
        ok: false,
        output: [...transcript, error.message].filter(Boolean).join('\n').slice(0, 65536),
        status: lastState.status,
      };
    } finally {
      busy = false;
      currentAction = null;
    }
  }
  return { actions, execute, status };
}
