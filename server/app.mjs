import express from 'express';
import helmet from 'helmet';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { modules } from '../content/curriculum.mjs';
import { createStore } from './store.mjs';
import { createLabRunner } from './lab.mjs';
import { incidents } from '../content/incidents.mjs';
import { publicIncident, createIncidentState, actIncident } from './incident-engine.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const localAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const kinds = new Set(['question', 'scenario']);
const lessons = new Map(
  modules.flatMap((module) => module.lessons).map((lesson) => [lesson.id, lesson]),
);
const incidentIds = new Set(incidents.map((incident) => incident.id));
const incidentActions = new Set(['observe', 'hypothesis', 'fix', 'verify', 'reset']);
const incidentChoiceActions = new Set(['observe', 'hypothesis', 'fix']);

function publicCourse(value) {
  if (Array.isArray(value)) return value.map(publicCourse);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'correctIndex' && key !== 'explanation')
        .map(([key, entry]) => [key, publicCourse(entry)]),
    );
  }
  return value;
}

function validBody(body, keys) {
  return (
    body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.keys(body).every((key) => keys.includes(key))
  );
}

export function createApp({
  dataDir = resolve(projectDir, 'data'),
  labRunner = createLabRunner(),
  distDir = resolve(projectDir, 'dist'),
  devOrigin,
} = {}) {
  const app = express();
  const store = createStore(dataDir);
  app.disable('x-powered-by');
  app.locals.close = () => store.close();
  app.use(
    helmet({
      strictTransportSecurity: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: null,
        },
      },
    }),
  );
  app.use((req, res, next) => {
    try {
      const host = req.get('host');
      if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/iu.test(host))
        throw new Error('host');
      const target = new URL(`http://${host}`);
      if (!localHosts.has(target.hostname) || !localAddresses.has(req.socket.remoteAddress))
        throw new Error('host');
      const origin = req.get('origin');
      if (origin && origin !== target.origin && origin !== devOrigin) throw new Error('origin');
      if (req.get('sec-fetch-site') === 'cross-site') throw new Error('origin');
      next();
    } catch {
      res.status(403).json({ error: 'Доступ разрешён только с локального адреса приложения.' });
    }
  });
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '64kb', strict: true }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/course', (_req, res) => res.json({ modules: publicCourse(modules) }));
  app.get('/api/progress', (_req, res) => res.json(store.progress()));
  app.post('/api/answer', (req, res) => {
    const { lessonId, kind, choice } = req.body ?? {};
    const assessment = kinds.has(kind) ? lessons.get(lessonId)?.[kind] : undefined;
    if (
      !validBody(req.body, ['lessonId', 'kind', 'choice']) ||
      !kinds.has(kind) ||
      !assessment ||
      !Number.isInteger(choice) ||
      choice < 0 ||
      choice >= assessment.options.length
    ) {
      return res
        .status(400)
        .json({ error: 'Укажите существующий урок, тип задания и номер варианта ответа.' });
    }
    const correct = choice === assessment.correctIndex;
    res.json({
      correct,
      explanation: assessment.explanation,
      progress: store.answer(lessonId, kind, correct),
    });
  });
  app.post('/api/notes', (req, res) => {
    const { lessonId, text } = req.body ?? {};
    if (
      !validBody(req.body, ['lessonId', 'text']) ||
      !lessons.has(lessonId) ||
      typeof text !== 'string' ||
      text.length > 10000
    ) {
      return res.status(400).json({
        error:
          'Заметка должна относиться к существующему уроку и содержать не более 10 000 символов.',
      });
    }
    store.note(lessonId, text);
    res.json({ ok: true });
  });
  app.get('/api/export', (_req, res) => {
    res.set('Content-Disposition', 'attachment; filename="kafka-workbench-progress.json"');
    res.json({
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      progress: store.progress(),
      mastery: store.mastery(),
      incidents: store.incidents(),
    });
  });
  app.post('/api/progress/reset', (req, res) => {
    if (!validBody(req.body, ['confirm']) || req.body.confirm !== 'RESET') {
      return res.status(400).json({ error: 'Для сброса прогресса передайте confirm: RESET.' });
    }
    store.reset();
    res.json({ ok: true, progress: store.progress() });
  });
  app.get('/api/incidents', (_req, res) =>
    res.json({
      incidents: incidents.map((incident) => publicIncident(incident.id)),
      progress: store.incidents(),
    }),
  );
  app.get('/api/incidents/:id', (req, res) => {
    const { id } = req.params;
    if (!incidentIds.has(id))
      return res.status(404).json({ error: 'Такого инцидента нет в тренажёре.' });
    res.json({
      incident: publicIncident(id),
      state: store.incident(id) ?? createIncidentState(id),
    });
  });
  app.post('/api/incidents/:id', (req, res) => {
    const { id } = req.params;
    if (!incidentIds.has(id))
      return res.status(404).json({ error: 'Такого инцидента нет в тренажёре.' });
    const { action, choice } = req.body ?? {};
    if (
      !validBody(req.body, ['action', 'choice']) ||
      !incidentActions.has(action) ||
      (incidentChoiceActions.has(action)
        ? typeof choice !== 'string' || choice.length > 120
        : choice !== undefined)
    ) {
      return res
        .status(400)
        .json({ error: 'Укажите допустимое действие и идентификатор варианта для этого шага.' });
    }
    try {
      const state = actIncident(id, store.incident(id) ?? createIncidentState(id), {
        action,
        choice,
      });
      store.saveIncident(id, state);
      res.json({ incident: publicIncident(id), state });
    } catch (error) {
      if (error.code !== 'INVALID_INCIDENT_INPUT') throw error;
      res.status(400).json({ error: error.message });
    }
  });
  app.get('/api/lab', async (_req, res) => res.json(await labRunner.status()));
  app.post('/api/lab', async (req, res) => {
    if (!validBody(req.body, ['action']) || !labRunner.actions.includes(req.body.action)) {
      return res.status(400).json({ error: 'Неизвестная операция лаборатории.' });
    }
    const result = await labRunner.execute(req.body.action);
    res.status(result.httpStatus ?? (result.ok ? 200 : 503)).json({
      ok: result.ok,
      output: result.output,
      ...(result.status ? { status: result.status } : {}),
    });
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Метод API не найден.' }));
  app.use(express.static(distDir, { index: false, etag: true }));
  app.get('/{*path}', (_req, res) => {
    const index = resolve(distDir, 'index.html');
    if (existsSync(index)) return res.sendFile(index);
    res.status(503).json({ error: 'Интерфейс ещё не собран. Выполните npm run build.' });
  });
  app.use((error, _req, res, _next) => {
    const status =
      error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({
      error:
        status === 413
          ? 'Запрос превышает 64 КБ.'
          : status === 400
            ? 'Некорректный JSON.'
            : 'Не удалось выполнить запрос.',
    });
  });
  return app;
}
