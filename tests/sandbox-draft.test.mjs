import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySandboxDraft, parseSandboxDraft } from '../src/sandbox-draft.ts';
import { produce, readBatch, restart, commit } from '../src/model.ts';

test('sandbox reload preserves uncommitted delivery and a separate group position', () => {
  const draft = emptySandboxDraft();
  draft.state = readBatch(produce(draft.state, 'order-73', 'Оплачен'), 'billing');
  draft.seen = draft.state.lastRead.map((r) => `billing:${r.partition}:${r.offset}`);
  const restored = parseSandboxDraft(JSON.stringify(draft));
  assert.deepEqual(restored, draft);
  const replay = readBatch(restart(restored.state, 'billing'), 'billing');
  assert.equal(replay.lastRead.length, 1);
  assert.equal(
    readBatch(restart(commit(replay, 'billing'), 'billing'), 'billing').lastRead.length,
    0,
  );
  assert.equal(readBatch(restored.state, 'analytics').lastRead.length, 1);
});
test('corrupt, out-of-bounds and oversized browser drafts recover to an empty usable model', () => {
  for (const raw of [null, '{', '{}', ' '.repeat(100001)])
    assert.deepEqual(parseSandboxDraft(raw), emptySandboxDraft());
  const draft = emptySandboxDraft();
  draft.state.groups.billing.committed[0] = 100;
  assert.deepEqual(parseSandboxDraft(JSON.stringify(draft)), emptySandboxDraft());
  draft.state = produce(emptySandboxDraft().state, 'one', 'event');
  draft.state.partitions.flat()[0].offset = 99;
  assert.deepEqual(parseSandboxDraft(JSON.stringify(draft)), emptySandboxDraft());
});
