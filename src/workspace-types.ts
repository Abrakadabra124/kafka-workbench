export type RecordRow = { partition: number; offset: number; key: string; value: string };
export type ClusterSnapshot = {
  topic: string;
  group: string;
  capturedAt: string;
  brokers: { id: number; running: boolean }[];
  partitions: {
    partition: number;
    leader: number;
    replicas: number[];
    isr: number[];
    end: number;
    committed: number | null;
    lag: number;
  }[];
};
export type RunEvent = {
  id: string;
  action: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  message: string;
  snapshot: ClusterSnapshot | null;
  result: { records?: RecordRow[]; passed?: boolean; checks?: { label: string; ok: boolean }[] };
};
export type WorkspaceState = {
  draft: string;
  attempt: number;
  prepared: boolean;
  verified: boolean;
  snapshot: ClusterSnapshot | null;
  history: RunEvent[];
  ledger: RecordRow[];
};
export type WorkspaceTask = {
  id: string;
  title: string;
  description: string;
  hint: string;
  consequence: string;
};
export type WorkspaceData = {
  available: boolean;
  busy: { id: string; action: string } | null;
  tasks: WorkspaceTask[];
  states: Record<string, WorkspaceState>;
};
