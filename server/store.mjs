import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'learning.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS answers (
      lesson_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('question', 'scenario')),
      correct INTEGER NOT NULL CHECK(correct IN (0, 1)),
      mastered INTEGER NOT NULL CHECK(mastered IN (0, 1)),
      attempts INTEGER NOT NULL CHECK(attempts > 0),
      PRIMARY KEY (lesson_id, kind)
    );
    CREATE TABLE IF NOT EXISTS notes (lesson_id TEXT PRIMARY KEY, text TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS incident_states (incident_id TEXT PRIMARY KEY, state TEXT NOT NULL);
    PRAGMA user_version = 2;
  `);
  const saveAnswer = db.prepare(`
    INSERT INTO answers (lesson_id, kind, correct, mastered, attempts) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(lesson_id, kind) DO UPDATE SET
      correct = excluded.correct,
      mastered = MAX(answers.mastered, excluded.mastered),
      attempts = answers.attempts + 1
  `);
  let closed = false;
  return {
    progress() {
      const answers = {};
      const mastery = new Map();
      for (const row of db.prepare('SELECT * FROM answers ORDER BY lesson_id, kind').all()) {
        answers[row.lesson_id] ??= {};
        answers[row.lesson_id][row.kind] = {
          correct: Boolean(row.correct),
          attempts: row.attempts,
        };
        if (row.mastered) mastery.set(row.lesson_id, (mastery.get(row.lesson_id) ?? 0) + 1);
      }
      const notes = Object.fromEntries(
        db
          .prepare('SELECT * FROM notes ORDER BY lesson_id')
          .all()
          .map((row) => [row.lesson_id, row.text]),
      );
      return {
        completed: [...mastery].filter(([, count]) => count === 2).map(([id]) => id),
        answers,
        notes,
      };
    },
    answer(lessonId, kind, correct) {
      saveAnswer.run(lessonId, kind, Number(correct), Number(correct));
      return this.progress();
    },
    mastery() {
      const mastery = {};
      for (const row of db
        .prepare('SELECT lesson_id, kind, mastered FROM answers ORDER BY lesson_id, kind')
        .all()) {
        mastery[row.lesson_id] ??= {};
        mastery[row.lesson_id][row.kind] = Boolean(row.mastered);
      }
      return mastery;
    },
    note(lessonId, text) {
      db.prepare(
        'INSERT INTO notes (lesson_id, text) VALUES (?, ?) ON CONFLICT(lesson_id) DO UPDATE SET text = excluded.text',
      ).run(lessonId, text);
    },
    incident(id) {
      const row = db.prepare('SELECT state FROM incident_states WHERE incident_id = ?').get(id);
      return row ? JSON.parse(row.state) : null;
    },
    saveIncident(id, state) {
      db.prepare(
        'INSERT INTO incident_states (incident_id, state) VALUES (?, ?) ON CONFLICT(incident_id) DO UPDATE SET state = excluded.state',
      ).run(id, JSON.stringify(state));
    },
    incidents() {
      return Object.fromEntries(
        db
          .prepare('SELECT * FROM incident_states ORDER BY incident_id')
          .all()
          .map((row) => [row.incident_id, JSON.parse(row.state)]),
      );
    },
    reset() {
      db.exec(
        'BEGIN IMMEDIATE; DELETE FROM answers; DELETE FROM notes; DELETE FROM incident_states; COMMIT;',
      );
    },
    close() {
      if (!closed) {
        closed = true;
        db.close();
      }
    },
  };
}
