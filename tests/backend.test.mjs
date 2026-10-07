import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { modules } from '../content/curriculum.mjs';
import { incidents } from '../content/incidents.mjs';

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'kafka-workbench-test-'));
  return directory;
}

function removeTemporaryDirectory(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('kafka-workbench-test-'));
  rmSync(directory, { recursive: true, force: true });
}

async function fixture(t) {
  const dataDir = temporaryDirectory();
  const calls = [];
  const distDir = join(dataDir, 'dist');
  mkdirSync(distDir);
  writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>Workbench fixture</title>');
  const app = createApp({
    dataDir,
    distDir,
    labRunner: {
      actions: ['start', 'stop'],
      status: async () => ({ available: true, running: false, status: 'stopped' }),
      execute: async (action) => {
        calls.push(action);
        return { ok: true, output: 'Verified fixture result', status: 'ready' };
      },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    app.locals.close();
    removeTemporaryDirectory(dataDir);
  });
  const request = async (path, body, headers = {}) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, body: await response.json() };
  };
  return { app, dataDir, base, request, calls };
}

test('API health, sanitized course, origin protection and bounded input', async (t) => {
  const { base, request } = await fixture(t);
  const health = await request('/api/health');
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body, { ok: true });
  assert.equal(health.response.headers.get('x-powered-by'), null);
  assert.match(health.response.headers.get('content-security-policy'), /script-src 'self'/u);
  assert.equal(health.response.headers.get('cache-control'), 'no-store');
  const course = await request('/api/course');
  assert.equal(course.body.modules.length, modules.length);
  assert.equal(JSON.stringify(course.body).includes('correctIndex'), false);
  assert.equal(JSON.stringify(course.body).includes('explanation'), false);
  for (const headers of [
    { host: 'attacker.example' },
    { host: 'localhost#attacker' },
    { origin: 'https://attacker.example' },
    { origin: 'null' },
    { origin: 'http://localhost:9999' },
    { 'sec-fetch-site': 'cross-site' },
    { host: 'attacker.example', 'x-forwarded-host': 'localhost' },
  ]) {
    // fetch correctly overrides Host, so use the raw HTTP client to test rebinding.
    const status = await new Promise((resolveStatus, reject) => {
      const req = httpRequest(base + '/api/health', { headers }, (response) => {
        response.resume();
        resolveStatus(response.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  assert.equal((await request('/api/health', undefined, { origin: base })).response.status, 200);
  const malformed = await fetch(base + '/api/answer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad}',
  });
  assert.equal(malformed.status, 400);
  assert.equal(typeof (await malformed.json()).error, 'string');
  const large = await request('/api/notes', { text: 'a'.repeat(70000) });
  assert.equal(large.response.status, 413);
  assert.equal((await request('/api/missing')).response.status, 404);
  assert.match(await (await fetch(base + '/learn/event-log')).text(), /Workbench fixture/u);
});

test('answers require two independent correct assessments, retain best completion and count every attempt', async (t) => {
  const { request } = await fixture(t);
  const lesson = modules[0].lessons[0];
  const answer = (kind, choice) => request('/api/answer', { lessonId: lesson.id, kind, choice });
  const wrongChoice = (lesson.question.correctIndex + 1) % lesson.question.options.length;
  const wrong = await answer('question', wrongChoice);
  assert.equal(wrong.body.correct, false);
  assert.equal(wrong.body.explanation, lesson.question.explanation);
  assert.deepEqual(wrong.body.progress.completed, []);
  const quiz = await answer('question', lesson.question.correctIndex);
  assert.deepEqual(quiz.body.progress.completed, []);
  const scenario = await answer('scenario', lesson.scenario.correctIndex);
  assert.deepEqual(scenario.body.progress.completed, [lesson.id]);
  const retry = await answer('question', wrongChoice);
  assert.equal(retry.body.correct, false);
  assert.deepEqual(retry.body.progress.completed, [lesson.id]);
  assert.deepEqual(retry.body.progress.answers[lesson.id].question, {
    correct: false,
    attempts: 3,
  });
  assert.deepEqual((await request('/api/export')).body.mastery[lesson.id], {
    question: true,
    scenario: true,
  });
  for (const body of [
    { lessonId: lesson.id, kind: 'question', choice: -1 },
    { lessonId: lesson.id, kind: 'question', choice: 0.5 },
    { lessonId: lesson.id, kind: { toString: null, valueOf: null }, choice: 0 },
    { lessonId: lesson.id, kind: 'question', choice: '0' },
    { lessonId: lesson.id, kind: 'question', choice: lesson.question.options.length },
    { lessonId: lesson.id, kind: '__proto__', choice: 0 },
    { lessonId: '__proto__', kind: 'question', choice: 0 },
    { lessonId: lesson.id, kind: 'question', choice: 0, correct: true },
    [],
    null,
  ])
    assert.equal((await request('/api/answer', body)).response.status, 400);
});

test('notes and progress persist in SQLite; export and explicit reset include the entire saved state', async (t) => {
  const { request, dataDir } = await fixture(t);
  const lesson = modules[0].lessons[0];
  const text = "Заметка: <script>alert('x')</script> и SQL '); DROP TABLE answers;";
  assert.equal((await request('/api/notes', { lessonId: lesson.id, text })).response.status, 200);
  await request('/api/answer', {
    lessonId: lesson.id,
    kind: 'question',
    choice: lesson.question.correctIndex,
  });
  const persisted = createStore(dataDir);
  assert.equal(persisted.progress().notes[lesson.id], text);
  assert.equal(persisted.progress().answers[lesson.id].question.attempts, 1);
  persisted.close();
  persisted.close();
  const exported = await request('/api/export');
  assert.equal(exported.body.schemaVersion, 2);
  assert.equal(exported.body.progress.notes[lesson.id], text);
  assert.equal(exported.body.progress.answers[lesson.id].question.attempts, 1);
  assert.match(exported.response.headers.get('content-disposition'), /attachment/u);
  assert.equal(
    (await request('/api/notes', { lessonId: lesson.id, text: 'x'.repeat(10001) })).response.status,
    400,
  );
  assert.equal(
    (await request('/api/notes', { lessonId: 'missing', text: 'x' })).response.status,
    400,
  );
  assert.equal((await request('/api/progress/reset', { confirm: true })).response.status, 400);
  assert.equal((await request('/api/progress')).body.notes[lesson.id], text);
  assert.equal((await request('/api/progress/reset', { confirm: 'RESET' })).response.status, 200);
  assert.deepEqual((await request('/api/progress')).body, {
    completed: [],
    answers: {},
    notes: {},
  });
});

test('laboratory endpoint accepts only fixed operations and does not pass arbitrary arguments', async (t) => {
  const { request, calls } = await fixture(t);
  assert.deepEqual((await request('/api/lab')).body, {
    available: true,
    running: false,
    status: 'stopped',
  });
  assert.equal(
    (await request('/api/lab', { action: 'start', command: 'rm -rf /' })).response.status,
    400,
  );
  assert.equal((await request('/api/lab', { action: 'exec' })).response.status, 400);
  assert.deepEqual(calls, []);
  assert.deepEqual((await request('/api/lab', { action: 'start' })).body, {
    ok: true,
    output: 'Verified fixture result',
    status: 'ready',
  });
  assert.deepEqual(calls, ['start']);
});

test('incident state persists across reloads, rejects forged actions, exports and resets', async (t) => {
  const { request, dataDir } = await fixture(t);
  const incident = incidents[0];
  const endpoint = `/api/incidents/${incident.id}`;
  const listing = await request('/api/incidents');
  assert.equal(listing.body.incidents.length, incidents.length);
  assert.deepEqual(listing.body.progress, {});
  assert.equal(JSON.stringify(listing.body).includes('correctIndex'), false);
  const original = (await request(endpoint)).body.state;
  assert.equal(original.verified, false);
  const observed = await request(endpoint, {
    action: 'observe',
    choice: incident.observations[0].id,
  });
  assert.equal(observed.response.status, 200);
  assert.ok(observed.body.state.observed.includes(incident.observations[0].id));
  assert.deepEqual((await request(endpoint)).body.state, observed.body.state);
  const reopened = createStore(dataDir);
  assert.deepEqual(reopened.incident(incident.id), observed.body.state);
  reopened.close();
  for (const body of [
    { action: 'complete' },
    { action: 'verify', verified: true },
    { action: 'fix', choice: '__proto__' },
    { action: 'observe', choice: 0 },
    { action: 'verify', choice: 'anything' },
    { action: 'observe', choice: incident.observations[0].id, state: { verified: true } },
  ])
    assert.equal((await request(endpoint, body)).response.status, 400);
  assert.equal(
    (await request(endpoint, { action: 'reset' }, { origin: 'https://attacker.example' })).response
      .status,
    403,
  );
  assert.deepEqual((await request(endpoint)).body.state, observed.body.state);
  const tooEarly = await request(endpoint, { action: 'verify' });
  assert.equal(tooEarly.response.status, 200);
  assert.equal(tooEarly.body.state.verified, false);
  assert.deepEqual((await request('/api/export')).body.incidents[incident.id], tooEarly.body.state);
  assert.equal((await request('/api/incidents/missing')).response.status, 404);
  await request('/api/progress/reset', { confirm: 'RESET' });
  assert.deepEqual((await request('/api/incidents')).body.progress, {});
  assert.deepEqual((await request(endpoint)).body.state, original);
});

test('adding incident storage preserves an existing version 1 learner database', (t) => {
  const dataDir = temporaryDirectory();
  const oldDb = new DatabaseSync(join(dataDir, 'learning.sqlite'));
  oldDb.exec(`
    CREATE TABLE answers (lesson_id TEXT, kind TEXT, correct INTEGER, mastered INTEGER, attempts INTEGER, PRIMARY KEY(lesson_id,kind));
    CREATE TABLE notes (lesson_id TEXT PRIMARY KEY, text TEXT NOT NULL);
    INSERT INTO answers VALUES ('event-log', 'question', 0, 1, 2);
    INSERT INTO notes VALUES ('event-log', 'Keep this existing note');
    PRAGMA user_version = 1;
  `);
  oldDb.close();
  const upgraded = createStore(dataDir);
  t.after(() => {
    upgraded.close();
    removeTemporaryDirectory(dataDir);
  });
  assert.equal(upgraded.progress().notes['event-log'], 'Keep this existing note');
  assert.deepEqual(upgraded.progress().answers['event-log'].question, {
    correct: false,
    attempts: 2,
  });
  assert.equal(upgraded.mastery()['event-log'].question, true);
  upgraded.saveIncident('lag-growth', { id: 'lag-growth', verified: false, observed: [] });
  assert.equal(upgraded.incident('lag-growth').verified, false);
});
