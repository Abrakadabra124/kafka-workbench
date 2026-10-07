import test from 'node:test';
import assert from 'node:assert/strict';
import { modules } from '../content/curriculum.mjs';
test('all 18 lessons have substantive unique content, usable assessments and official sources', () => {
  const lessons = modules.flatMap(m => m.lessons);
  assert.equal(modules.length, 6); assert.equal(lessons.length, 18);
  assert.equal(new Set(lessons.map(l => l.id)).size, 18);
  assert.equal(lessons[0].id, 'event-log');
  for (const lesson of lessons) {
    assert.ok(lesson.theory.length >= 3, lesson.id);
    assert.ok(lesson.theory.every(s => s.body.length > 100), lesson.id);
    for (const kind of ['question', 'scenario']) {
      assert.equal(new Set(lesson[kind].options).size, 4, lesson.id);
      assert.ok(Number.isInteger(lesson[kind].correctIndex));
      assert.ok(lesson[kind].correctIndex >= 0 && lesson[kind].correctIndex < 4);
      assert.ok(lesson[kind].explanation.length > 30);
    }
    assert.ok(lesson.sources.length);
    for (const source of lesson.sources) {
      const url = new URL(source.url);
      assert.equal(url.protocol, 'https:');
      assert.ok(['kafka.apache.org', 'developer.confluent.io', 'docs.confluent.io'].includes(url.hostname));
    }
  }
});
