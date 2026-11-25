import { initialState, type LogState, type GroupId } from './model.ts';

export type SandboxDraft = {
  state: LogState;
  group: GroupId;
  consumers: number;
  key: string;
  value: string;
  message: string;
  journal: string[];
  restarted: boolean;
  redelivered: boolean;
  seen: string[];
};
export const sandboxDraftKey = 'kafka-sandbox-draft-v1';
export function emptySandboxDraft(): SandboxDraft {
  return {
    state: initialState(),
    group: 'billing',
    consumers: 2,
    key: 'order-42',
    value: 'Заказ создан',
    message: 'Отправьте первое событие.',
    journal: [],
    restarted: false,
    redelivered: false,
    seen: [],
  };
}
export function parseSandboxDraft(raw: string | null): SandboxDraft {
  try {
    if (!raw || raw.length > 100000) return emptySandboxDraft();
    const d = JSON.parse(raw) as SandboxDraft;
    const s = d.state;
    if (
      !Array.isArray(s.partitions) ||
      s.partitions.length !== 3 ||
      s.partitions.some((p) => !Array.isArray(p)) ||
      s.partitions.flat().length > 60
    )
      throw new Error('records');
    for (const [p, records] of s.partitions.entries())
      for (const [i, record] of records.entries()) {
        if (
          record.partition !== p ||
          record.offset !== i ||
          typeof record.key !== 'string' ||
          record.key.length > 64 ||
          typeof record.value !== 'string' ||
          record.value.length > 500
        )
          throw new Error('record');
      }
    for (const group of ['billing', 'analytics'] as const)
      for (const name of ['position', 'committed'] as const) {
        const offsets = s.groups[group][name];
        if (
          !Array.isArray(offsets) ||
          offsets.length !== 3 ||
          offsets.some((n, p) => !Number.isInteger(n) || n < 0 || n > s.partitions[p].length)
        )
          throw new Error('offset');
      }
    if (
      !Array.isArray(s.lastRead) ||
      s.lastRead.length > 3 ||
      s.lastRead.some((r) => !s.partitions[r.partition]?.[r.offset])
    )
      throw new Error('lastRead');
    if (
      !['billing', 'analytics'].includes(d.group) ||
      !Number.isInteger(d.consumers) ||
      d.consumers < 1 ||
      d.consumers > 6
    )
      throw new Error('group');
    if (
      typeof d.key !== 'string' ||
      d.key.length > 64 ||
      typeof d.value !== 'string' ||
      d.value.length > 500 ||
      typeof d.message !== 'string' ||
      d.message.length > 2000
    )
      throw new Error('input');
    if (
      !Array.isArray(d.journal) ||
      d.journal.length > 12 ||
      d.journal.some((v) => typeof v !== 'string' || v.length > 2000)
    )
      throw new Error('journal');
    if (
      !Array.isArray(d.seen) ||
      d.seen.length > 120 ||
      d.seen.some((v) => typeof v !== 'string' || v.length > 100) ||
      typeof d.restarted !== 'boolean' ||
      typeof d.redelivered !== 'boolean'
    )
      throw new Error('challenge');
    s.lastRead = s.lastRead.map((record) => s.partitions[record.partition][record.offset]);
    return d;
  } catch {
    return emptySandboxDraft();
  }
}
