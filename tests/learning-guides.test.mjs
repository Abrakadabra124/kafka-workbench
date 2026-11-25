import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { modules } from '../content/curriculum.mjs';
import { incidents } from '../content/incidents.mjs';
import { workspaceTasks } from '../server/workspace.mjs';
import { lessonGuides } from '../content/lesson-guides.mjs';
import { practiceGuides } from '../content/practice-guides.mjs';
import { createApp } from '../server/app.mjs';
import { createStore } from '../server/store.mjs';
import { createIncidentState } from '../server/incident-engine.mjs';
import { defaultRecipe } from '../server/workspace.mjs';

const lessons = modules.flatMap((module) => module.lessons);
const expectedPracticeIds = [
  'sandbox',
  ...incidents.map(({ id }) => `incident/${id}`),
  ...workspaceTasks.map(({ id }) => `workspace/${id}`),
  'basic-lab',
];

function russianText(value, label, minimum = 12) {
  assert.equal(typeof value, 'string', `${label}: expected text`);
  assert.match(value, /[А-Яа-яЁё]/u, `${label}: Russian explanation required`);
  assert.ok(value.trim().length >= minimum, `${label}: explanation must be substantive`);
}

function guideContract(guide, id) {
  assert.ok(guide && typeof guide === 'object', `${id}: missing guide`);
  for (const field of ['problem', 'goal', 'success', 'transfer']) {
    russianText(guide[field], `${id}.${field}`);
  }
  assert.ok(guide.terms.length >= 2, `${id}: explain new terminology`);
  assert.equal(new Set(guide.terms.map(({ term }) => term)).size, guide.terms.length);
  for (const entry of guide.terms) {
    assert.ok(entry.term.trim(), `${id}: empty term`);
    russianText(entry.meaning, `${id}.terms.${entry.term}`);
  }
  assert.ok(guide.mechanism.length >= 2, `${id}: explain how and why`);
  for (const paragraph of guide.mechanism) russianText(paragraph, `${id}.mechanism`);
  assert.ok(guide.documentation.length >= 2, `${id}: reference and diagnostics required`);
  for (const section of guide.documentation) {
    russianText(section.title, `${id}.documentation.title`, 1);
    assert.ok(section.syntax.trim(), `${id}: preserve exact syntax or setting`);
    for (const field of ['explanation', 'check', 'limitation']) {
      russianText(section[field], `${id}.documentation.${field}`);
    }
  }
  russianText(guide.example.title, `${id}.example.title`);
  russianText(guide.example.context, `${id}.example.context`);
  assert.ok(guide.example.steps.length >= 4, `${id}: initial/action/change/check required`);
  const states = new Set();
  const evidence = new Set();
  for (const [index, step] of guide.example.steps.entries()) {
    for (const field of ['title', 'action', 'reason', 'evidence']) {
      russianText(step[field], `${id}.example.${index}.${field}`, field === 'title' ? 1 : 12);
    }
    assert.ok(step.nodes.length >= 2, `${id}: labelled components required`);
    assert.equal(new Set(step.nodes.map(({ label }) => label)).size, step.nodes.length);
    for (const node of step.nodes) {
      assert.match(node.label, /[А-Яа-яЁё]/u, `${id}: component labels must be Russian`);
      assert.ok(String(node.value).trim(), `${id}: every component needs a visible state`);
    }
    states.add(JSON.stringify(step.nodes));
    evidence.add(step.evidence);
  }
  assert.ok(states.size >= 3, `${id}: the diagram must change with the example`);
  assert.ok(evidence.size >= 3, `${id}: evidence must explain each visible state`);
}

test('learning guides cover the actual 18 lessons and all 14 practice entry points exactly', () => {
  assert.equal(lessons.length, 18);
  assert.equal(expectedPracticeIds.length, 14);
  assert.deepEqual(Object.keys(lessonGuides).sort(), lessons.map(({ id }) => id).sort());
  assert.deepEqual(Object.keys(practiceGuides).sort(), expectedPracticeIds.sort());
});

test('all 32 guides provide Russian instruction, reference, causal visual example and transfer', () => {
  const guides = [...Object.entries(lessonGuides), ...Object.entries(practiceGuides)];
  const problems = new Set();
  const examples = new Set();
  for (const [id, guide] of guides) {
    guideContract(guide, id);
    problems.add(guide.problem);
    examples.add(JSON.stringify(guide.example));
  }
  assert.equal(problems.size, guides.length, 'each entry needs a subject-specific work problem');
  assert.equal(examples.size, guides.length, 'each entry needs its own working example');
});

test('every one of 144 answer choices has its own Russian explanation and next-attempt hint', () => {
  let checkedChoices = 0;
  for (const lesson of lessons) {
    const guide = lessonGuides[lesson.id];
    for (const kind of ['question', 'scenario']) {
      const assessment = lesson[kind];
      const feedback = guide.feedback[kind];
      assert.equal(
        feedback.length,
        assessment.options.length,
        `${lesson.id}.${kind}: index alignment`,
      );
      assert.equal(
        new Set(feedback.map(({ explanation }) => explanation)).size,
        feedback.length,
        `${lesson.id}.${kind}: the explanation must address the selected choice`,
      );
      for (const [index, item] of feedback.entries()) {
        russianText(item.explanation, `${lesson.id}.${kind}.${index}.explanation`);
        russianText(item.hint, `${lesson.id}.${kind}.${index}.hint`);
        checkedChoices += 1;
      }
      assert.ok(
        feedback[assessment.correctIndex],
        `${lesson.id}.${kind}: correct outcome needs feedback`,
      );
    }
  }
  assert.equal(checkedChoices, 144);
});

test('practice references identify the source language and link directly to authoritative documentation', () => {
  const domains = new Set(['kafka.apache.org', 'developer.confluent.io', 'docs.confluent.io']);
  for (const [id, guide] of Object.entries(practiceGuides)) {
    assert.ok(guide.sources.length, `${id}: sources are required`);
    for (const source of guide.sources) {
      const url = new URL(source.url);
      assert.equal(url.protocol, 'https:');
      assert.ok(domains.has(url.hostname), `${id}: unexpected source ${url.hostname}`);
      assert.equal(source.language, 'английский', `${id}: declare link language`);
      assert.ok(source.title.trim());
    }
  }
});

async function apiFixture(t, prepare) {
  const dataDir = mkdtempSync(join(tmpdir(), 'kafka-learning-flow-test-'));
  if (prepare) {
    const store = createStore(dataDir);
    try {
      prepare(store);
    } finally {
      store.close();
    }
  }
  let app;
  let server;
  let base;
  const close = async () => {
    if (!server) return;
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    app.locals.close();
    server = null;
  };
  const start = async () => {
    // The learning path does not depend on Docker. Any accidental lab execution is an error.
    app = createApp({
      dataDir,
      labRunner: {
        actions: [],
        status: async () => ({ available: false, running: false, status: 'not used in this test' }),
        execute: async () => {
          throw new Error('Learning material must not execute a lab');
        },
      },
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  };
  await start();
  t.after(async () => {
    await close();
    assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
    assert.ok(basename(dataDir).startsWith('kafka-learning-flow-test-'));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const request = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined
        ? {}
        : {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    request,
    reopen: async () => {
      await close();
      await start();
    },
  };
}

const learningUrl = (id) => `/api/learning/${encodeURIComponent(id)}`;

test('all 32 direct learning APIs begin at theory, enforce sequence and preserve unlocked rereading after restart', async (t) => {
  const { request, reopen } = await apiFixture(t);
  const ids = [...lessons.map(({ id }) => `lesson/${id}`), ...expectedPracticeIds];
  for (const id of ids) {
    const path = learningUrl(id);
    const first = await request(path);
    assert.equal(first.status, 200, id);
    assert.deepEqual(first.body.progress, { stage: 0, unlocked: 0 }, id);
    assert.equal(
      first.body.guide.feedback,
      undefined,
      `${id}: do not reveal answer feedback before submission`,
    );
    assert.equal(JSON.stringify(first.body).includes('correctIndex'), false, id);
    assert.equal((await request(path, { stage: 3 })).status, 409, `${id}: cannot skip material`);
    for (const stage of [1, 2, 3]) {
      const next = await request(path, { stage });
      assert.equal(next.status, 200, `${id} stage ${stage}`);
      assert.deepEqual(next.body.progress, { stage, unlocked: stage }, id);
    }
    assert.deepEqual(
      (await request(path, { stage: 1 })).body.progress,
      { stage: 1, unlocked: 3 },
      id,
    );
  }
  await reopen();
  for (const id of ids) {
    assert.deepEqual((await request(learningUrl(id))).body.progress, { stage: 1, unlocked: 3 }, id);
    assert.deepEqual(
      (await request(learningUrl(id), { stage: 3 })).body.progress,
      { stage: 3, unlocked: 3 },
      id,
    );
  }
  const exported = (await request('/api/export')).body;
  assert.equal(Object.keys(exported.learningPaths).length, 32);
  assert.deepEqual(exported.progress, { completed: [], answers: {}, notes: {} });
  assert.deepEqual(exported.incidents, {});
  assert.deepEqual(exported.workspaces, {});
});

test('learning API rejects unknown IDs, forged unlocked state and malformed stage without changing progress', async (t) => {
  const { request } = await apiFixture(t);
  const path = learningUrl('lesson/event-log');
  assert.equal((await request(learningUrl('lesson/missing'))).status, 404);
  assert.equal((await request(learningUrl('lesson/missing'), { stage: 0 })).status, 400);
  for (const body of [
    {},
    { stage: -1 },
    { stage: 4 },
    { stage: 1.5 },
    { stage: '1' },
    { stage: null },
    { stage: true },
    { stage: 1, unlocked: 3 },
    { stage: 1, extra: true },
  ]) {
    assert.equal((await request(path, body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual((await request(path)).body.progress, { stage: 0, unlocked: 0 });
  assert.deepEqual((await request('/api/export')).body.learningPaths, {});
});

test('explicit progress reset clears new learning paths without deleting saved laboratory drafts', async (t) => {
  const draft = { draft: defaultRecipe(), history: [], verified: false };
  const { request } = await apiFixture(t, (store) => {
    store.saveWorkspace('delivery', draft);
  });
  for (const stage of [1, 2, 3]) {
    assert.equal((await request(learningUrl('lesson/event-log'), { stage })).status, 200);
  }
  assert.equal((await request(learningUrl('workspace/delivery'), { stage: 3 })).status, 200);
  assert.equal((await request('/api/progress/reset', { confirm: 'RESET' })).status, 200);
  const exported = (await request('/api/export')).body;
  assert.deepEqual(exported.learningPaths, {});
  assert.deepEqual(exported.workspaces.delivery, draft);
  assert.deepEqual((await request(learningUrl('lesson/event-log'))).body.progress, {
    stage: 0,
    unlocked: 0,
  });
  assert.deepEqual((await request(learningUrl('workspace/delivery'))).body.progress, {
    stage: 0,
    unlocked: 3,
  });
});

test('existing answers, notes, incident evidence and saved lab drafts remain usable when adopting learning paths', async (t) => {
  const oldIncident = createIncidentState('lag-growth');
  oldIncident.observed = ['rates'];
  const oldWorkspace = { draft: defaultRecipe(), history: [], verified: false };
  const { request, reopen } = await apiFixture(t, (store) => {
    store.answer('event-log', 'question', true);
    store.note('event-log', 'Сохранённая рабочая заметка до появления нового маршрута.');
    store.saveIncident('lag-growth', oldIncident);
    store.saveWorkspace('delivery', oldWorkspace);
  });
  const before = (await request('/api/export')).body;
  for (const id of ['lesson/event-log', 'incident/lag-growth', 'workspace/delivery']) {
    assert.deepEqual((await request(learningUrl(id))).body.progress, { stage: 0, unlocked: 3 }, id);
    assert.equal((await request(learningUrl(id), { stage: 3 })).status, 200, id);
    assert.equal((await request(learningUrl(id), { stage: 0 })).status, 200, id);
  }
  assert.deepEqual((await request(learningUrl('lesson/keys-partitions'))).body.progress, {
    stage: 0,
    unlocked: 0,
  });
  await reopen();
  const after = (await request('/api/export')).body;
  for (const field of ['progress', 'mastery', 'incidents', 'workspaces']) {
    assert.deepEqual(
      after[field],
      before[field],
      `${field}: adopting the new path must preserve saved work`,
    );
  }
  for (const id of ['lesson/event-log', 'incident/lag-growth', 'workspace/delivery']) {
    assert.deepEqual(after.learningPaths[id], { stage: 0, unlocked: 3 });
  }
});

test('answer API returns the selected option explanation and hint for all 144 choices and retains mastery', async (t) => {
  const { request, reopen } = await apiFixture(t);
  for (const lesson of lessons) {
    for (const kind of ['question', 'scenario']) {
      for (const choice of lesson[kind].options.keys()) {
        const result = await request('/api/answer', { lessonId: lesson.id, kind, choice });
        const expected = lessonGuides[lesson.id].feedback[kind][choice];
        assert.equal(result.status, 200);
        assert.equal(result.body.correct, choice === lesson[kind].correctIndex);
        assert.equal(
          result.body.explanation,
          expected.explanation,
          `${lesson.id}.${kind}.${choice}`,
        );
        assert.equal(result.body.hint, expected.hint, `${lesson.id}.${kind}.${choice}`);
        assert.equal(result.body.progress.answers[lesson.id][kind].attempts, choice + 1);
      }
    }
  }
  await reopen();
  const progress = (await request('/api/progress')).body;
  assert.deepEqual(progress.completed.sort(), lessons.map(({ id }) => id).sort());
  for (const lesson of lessons) {
    for (const kind of ['question', 'scenario'])
      assert.equal(progress.answers[lesson.id][kind].attempts, 4);
  }
});
