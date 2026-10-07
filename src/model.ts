export type EventRecord = { key: string; value: string; partition: number; offset: number };
export type GroupId = 'billing' | 'analytics';
export type Group = { position: number[]; committed: number[] };
export type LogState = { partitions: EventRecord[][]; groups: Record<GroupId, Group>; lastRead: EventRecord[] };
export function initialState(): LogState {
  return { partitions: [[], [], []], groups: { billing: { position: [0, 0, 0], committed: [0, 0, 0] }, analytics: { position: [0, 0, 0], committed: [0, 0, 0] } }, lastRead: [] };
}
export function produce(state: LogState, key: string, value: string): LogState {
  if (!key.trim() || key.length > 64 || !value.trim() || value.length > 500) throw new Error('Нужен ключ до 64 и событие до 500 символов.');
  if (state.partitions.flat().length >= 60) throw new Error('В модели максимум 60 событий. Начните эксперимент заново.');
  // Deliberately simple teaching hash, not the Kafka Java partitioner.
  const hash = [...key].reduce((sum, char) => (sum * 31 + char.codePointAt(0)!) >>> 0, 0);
  const partition = hash % state.partitions.length;
  const next = structuredClone(state);
  next.partitions[partition].push({ key, value, partition, offset: next.partitions[partition].length });
  return next;
}
export function readBatch(state: LogState, group: GroupId): LogState {
  const next = structuredClone(state);
  next.lastRead = [];
  next.partitions.forEach((records, p) => {
    const event = records[next.groups[group].position[p]];
    if (event) { next.lastRead.push(event); next.groups[group].position[p]++; }
  });
  return next;
}
export function commit(state: LogState, group: GroupId): LogState {
  const next = structuredClone(state);
  next.groups[group].committed = [...next.groups[group].position];
  return next;
}
export function restart(state: LogState, group: GroupId): LogState {
  const next = structuredClone(state);
  next.groups[group].position = [...next.groups[group].committed];
  next.lastRead = [];
  return next;
}
export function lag(state: LogState, group: GroupId): number {
  return state.partitions.reduce((sum, records, p) => sum + records.length - state.groups[group].committed[p], 0);
}
export function assign(partitions: number, consumers: number): number[] {
  if (!Number.isInteger(consumers) || consumers < 1 || consumers > 6) throw new Error('От 1 до 6 потребителей.');
  return Array.from({ length: partitions }, (_, i) => i % consumers);
}
