import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPractice, practiceTransition as act } from '../src/practice-model.ts';
for (const id of ['poison-quarantine', 'isr-write-gate', 'retention-gap']) {
  test(id + ': causal actions, two failed choices, repair, repeat and reset', () => {
    let s = initialPractice(id);
    assert.equal(act(s, 'verify').verified, false);
    assert.equal(act(s, 'repair').repaired, false);
    s = act(act(s, 'fault'), 'inspect');
    for (const a of ['wrong1', 'wrong2']) {
      const wrong = act(s, a);
      assert.equal(act(wrong, 'verify').verified, false);
      assert.notDeepEqual(wrong, s);
      const fixed = act(wrong, 'repair');
      assert.equal(act(fixed, 'verify').verified, true);
      assert.deepEqual(act(fixed, 'repair').source, fixed.source);
    }
    const done = act(act(s, 'repair'), 'verify');
    assert.equal(done.verified, true);
    assert.deepEqual(
      act(done, 'wrong2').recovered,
      done.recovered,
      'a retry never deletes recovered effects',
    );
    const shortcuts = act(act(s, 'wrong1'), 'wrong2');
    assert.equal(act(shortcuts, 'verify').verified, false);
    if (id === 'isr-write-gate') {
      assert.ok(shortcuts.source.includes('weak-write'));
      assert.match(shortcuts.message, /принята/);
    }
    if (id === 'poison-quarantine') assert.match(shortcuts.message, /не читает E1/);
    assert.deepEqual(act(done, 'reset'), initialPractice(id));
    if (id === 'retention-gap') {
      assert.deepEqual(s.source, ['E1', 'E2']);
      assert.deepEqual(done.recovered, ['E0', 'E1', 'E2']);
    }
    if (id === 'poison-quarantine') {
      assert.equal(s.committed, 1);
      assert.deepEqual(done.quarantine, ['E1']);
    }
    if (id === 'isr-write-gate') {
      assert.equal(s.isr, 2);
      assert.equal(done.minIsr, 3);
    }
  });
}
