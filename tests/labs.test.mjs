import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createLabRunner, sampleRecords, runDockerCommand } from '../server/lab.mjs';

test('Docker output preserves UTF-8 paths and diagnostics across split pipe chunks', async () => {
  const expectedOutput = JSON.stringify({
    Labels: { 'com.docker.compose.project.config_files': 'C:/work/Тренажёры/compose.yaml' },
  });
  const expectedError = 'Проверка завершена';
  const result = await runDockerCommand(['compose', 'ps'], {
    spawnProcess: (executable, args, options) => {
      assert.equal(executable, 'docker');
      assert.deepEqual(args, ['compose', 'ps']);
      assert.equal(options.shell, false);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        for (const [stream, text] of [
          [child.stdout, expectedOutput],
          [child.stderr, expectedError],
        ]) {
          for (const byte of Buffer.from(text, 'utf8')) stream.write(Buffer.from([byte]));
          stream.end();
        }
        child.emit('close', 0);
      });
      return child;
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, expectedOutput);
  assert.equal(result.stderr, expectedError);
  assert.equal(result.outputLimited, false);
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(expectedOutput));
});

const success = (stdout = '', stderr = '') => ({
  code: 0,
  stdout,
  stderr,
  timedOut: false,
  outputLimited: false,
});
const description = 'Topic: orders\tPartitionCount: 3\tReplicationFactor: 1\n';
function fakeDocker({ faultyOffsets = false, badRecords = false } = {}) {
  const calls = [];
  let produced = 0;
  let running = false;
  return {
    calls,
    runCommand: async (args, options = {}) => {
      calls.push({ args, options });
      if (args[0] === 'version') return success('29.8.0');
      if (args.includes('up')) {
        running = true;
        return success('Started');
      }
      if (args.includes('down')) {
        running = false;
        return success('Removed');
      }
      if (args.includes('ps'))
        return success(
          running
            ? JSON.stringify([
                {
                  Service: 'broker',
                  State: 'running',
                  Health: 'healthy',
                  Labels: { 'com.docker.compose.project.config_files': args[4] },
                },
              ])
            : '[]',
        );
      const script = args.find((argument) => argument.endsWith('.sh'));
      if (script?.endsWith('kafka-topics.sh'))
        return success(args.includes('--describe') ? description : 'orders');
      if (script?.endsWith('kafka-get-offsets.sh'))
        return success(`orders:0:${produced}\norders:1:0\norders:2:0\n`);
      if (script?.endsWith('kafka-console-producer.sh')) {
        produced += faultyOffsets ? 0 : 3;
        return success();
      }
      if (script?.endsWith('kafka-console-consumer.sh'))
        return success(
          badRecords ? 'unexpected data\n' : sampleRecords.join('\n') + '\n',
          'Processed a total of 3 messages',
        );
      if (script?.endsWith('kafka-consumer-groups.sh'))
        return success('GROUP TOPIC PARTITION CURRENT-OFFSET LOG-END-OFFSET LAG');
      throw new Error('Unexpected command in test: ' + args.join(' '));
    },
  };
}

test('runner scopes every Docker mutation, fixes topic and samples, and verifies outcomes', async () => {
  const fake = fakeDocker();
  const runner = createLabRunner(fake);
  for (const action of ['start', 'topic', 'topic', 'produce', 'consume', 'inspect', 'stop']) {
    const result = await runner.execute(action);
    assert.equal(result.ok, true, `${action}: ${result.output}`);
  }
  for (const { args } of fake.calls.filter((call) => call.args[0] !== 'version')) {
    assert.deepEqual(args.slice(0, 4), [
      'compose',
      '--project-name',
      'kafka-workbench-lab',
      '--file',
    ]);
    assert.equal(args.includes('prune'), false);
    assert.equal(args.includes('sh'), false);
    assert.equal(args.includes('bash'), false);
  }
  const producer = fake.calls.find((call) =>
    call.args.some((argument) => argument.endsWith('kafka-console-producer.sh')),
  );
  assert.equal(producer.options.input, sampleRecords.join('\n') + '\n');
  assert.equal((await runner.execute('rm')).httpStatus, 400);
});

test('zero exit code alone cannot validate produced offsets or consumed records', async () => {
  const badOffsets = await createLabRunner(fakeDocker({ faultyOffsets: true })).execute('produce');
  assert.equal(badOffsets.ok, false);
  assert.match(badOffsets.output, /ожидалось 3/u);
  const badRecords = await createLabRunner(fakeDocker({ badRecords: true })).execute('consume');
  assert.equal(badRecords.ok, false);
  assert.match(badRecords.output, /не совпадают/u);
});

test('consumer exceptions and unverified zero-record reads are not reported as success', async () => {
  const fake = fakeDocker();
  const runner = createLabRunner({
    runCommand: (args, options) =>
      args.some((argument) => argument.endsWith('kafka-console-consumer.sh'))
        ? success(
            '',
            'ERROR org.apache.kafka.common.errors.AuthenticationException\nProcessed a total of 0 messages',
          )
        : fake.runCommand(args, options),
  });
  assert.equal((await runner.execute('consume')).ok, false);
  const unverified = createLabRunner({
    runCommand: (args, options) =>
      args.some((argument) => argument.endsWith('kafka-console-consumer.sh'))
        ? success(
            '',
            'org.apache.kafka.common.errors.TimeoutException\nProcessed a total of 0 messages',
          )
        : fake.runCommand(args, options),
  });
  assert.equal((await unverified.execute('produce')).ok, true);
  assert.equal((await unverified.execute('consume')).ok, false);
});

test('live test namespace cannot remove the learner project', async () => {
  const fake = fakeDocker();
  const runner = createLabRunner({ ...fake, testMode: true });
  assert.equal((await runner.execute('stop')).ok, true);
  for (const { args } of fake.calls.filter((call) => call.args[0] === 'compose'))
    assert.equal(args[2], 'kafka-workbench-lab-test');
});

test('a lab owned by another checkout is never mutated or removed', async () => {
  const calls = [];
  const runner = createLabRunner({
    runCommand: async (args) => {
      calls.push(args);
      return success(
        JSON.stringify([
          {
            Service: 'broker',
            Labels: {
              'com.docker.compose.project.config_files': '/another/checkout/labs/compose.yaml',
            },
          },
        ]),
      );
    },
  });
  assert.equal((await runner.execute('stop')).ok, false);
  assert.equal(
    calls.some((args) => args.includes('down')),
    false,
  );
});

test('unavailable daemon and timed out operations remain explicit failures', async () => {
  const absent = createLabRunner({
    runCommand: async () => ({ code: -1, stdout: '', stderr: 'not running', timedOut: false }),
  });
  assert.equal((await absent.status()).available, false);
  const timeout = createLabRunner({
    runCommand: async () => ({ code: 0, stdout: '', stderr: '', timedOut: true }),
  });
  const result = await timeout.execute('start');
  assert.equal(result.ok, false);
  assert.match(result.output, /Время ожидания истекло/u);
});

test('overlapping mutations are rejected and release the lock after completion', async () => {
  const fake = fakeDocker();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let blocked = false;
  const runner = createLabRunner({
    runCommand: async (...args) => {
      if (args[0].includes('up') && !blocked) {
        blocked = true;
        await gate;
      }
      return fake.runCommand(...args);
    },
  });
  const first = runner.execute('start');
  assert.equal((await runner.execute('stop')).httpStatus, 409);
  assert.match((await runner.status()).status, /start/u);
  release();
  assert.equal((await first).ok, true);
  assert.equal((await runner.execute('stop')).ok, true);
});

test(
  'real Kafka: broker readiness, three partitions, keyed records, group state and scoped cleanup',
  { skip: process.env.RUN_LIVE_LABS !== '1', timeout: 360000 },
  async (t) => {
    const runner = createLabRunner({ testMode: true });
    t.after(async () => {
      const stopped = await runner.execute('stop');
      assert.equal(stopped.ok, true, `Cleanup failed: ${stopped.output}`);
      assert.equal((await runner.status()).running, false);
    });
    assert.equal(
      (await runner.status()).available,
      true,
      'Start Docker Desktop / Engine before running the live lab test.',
    );
    for (const action of ['start', 'topic', 'topic', 'produce', 'consume', 'inspect']) {
      const result = await runner.execute(action);
      t.diagnostic(`${action}: ${result.output}`);
      assert.equal(result.ok, true, `${action}: ${result.output}`);
      if (action === 'consume')
        for (const record of sampleRecords) assert.ok(result.output.includes(record));
    }
    const exhausted = await runner.execute('consume');
    t.diagnostic(`consume again: ${exhausted.output}`);
    assert.equal(exhausted.ok, true, exhausted.output);
    assert.match(exhausted.output, /Новых записей/u);
  },
);
