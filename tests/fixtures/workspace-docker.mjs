// Deterministic test double. Used only by automated tests, never by the app server.
export function workspaceDocker() {
  const topics = new Map(),
    groups = new Map(),
    calls = [];
  let running = [];
  const ok = (value) => ({
    code: 0,
    stdout: typeof value === 'string' ? value : JSON.stringify(value),
    stderr: '',
  });
  return {
    calls,
    runCommand: async (args, options = {}) => {
      calls.push({ args, options });
      if (args[0] === 'version') return ok('test-double');
      if (args.includes('up')) {
        running = [1, 2, 3];
        return ok('');
      }
      if (args.includes('stop')) {
        running = [1, 2];
        return ok('');
      }
      if (args.includes('start')) {
        running = [1, 2, 3];
        return ok('');
      }
      if (args.includes('down')) {
        running = [];
        topics.clear();
        groups.clear();
        return ok('');
      }
      if (args.includes('ps'))
        return ok(
          [1, 2, 3]
            .filter((n) => running.length)
            .map((n) => ({
              Service: `broker${n}`,
              State: running.includes(n) ? 'running' : 'exited',
              Labels: { 'com.docker.compose.project.config_files': args[4] },
            })),
        );
      if (args.includes('build')) return ok('');
      const index = args.indexOf('Workbench');
      if (index < 0) throw new Error(`Unexpected test command: ${args}`);
      const [action, topic, group, limit, commit] = args.slice(index + 1);
      const records = topics.get(topic) ?? [];
      if (action === 'prepare') {
        topics.set(topic, []);
        groups.delete(`${topic}-orders`);
        groups.delete(`${topic}-audit`);
        return ok({ prepared: true });
      }
      if (action === 'snapshot')
        return ok({
          topic,
          group,
          partitions: [0, 1, 2].map((partition) => {
            const end = records.filter((r) => r.partition === partition).length;
            const committed = groups.get(group)?.[partition] ?? null;
            return {
              partition,
              leader: partition === 2 && !running.includes(3) ? 1 : partition + 1,
              replicas: [1, 2, 3],
              isr: running,
              end,
              committed,
              lag: end - (committed ?? 0),
            };
          }),
        });
      if (action === 'produce') {
        const added = options.input
          .trim()
          .split('\n')
          .map((line) => {
            const [p, k, v] = line.split('\t');
            const partition = Number(p);
            const row = {
              partition,
              offset: records.filter((r) => r.partition === partition).length,
              key: Buffer.from(k, 'base64').toString(),
              value: Buffer.from(v, 'base64').toString(),
            };
            records.push(row);
            return row;
          });
        topics.set(topic, records);
        return ok({ records: added });
      }
      if (action === 'consume' || action === 'read-all') {
        const selected = records
          .filter(
            (r) => action === 'read-all' || r.offset >= (groups.get(group)?.[r.partition] ?? 0),
          )
          .slice(0, Number(limit));
        if (commit === 'true') {
          const offsets = groups.get(group) ?? {};
          for (const r of selected) offsets[r.partition] = r.offset + 1;
          groups.set(group, offsets);
        }
        return ok({ records: selected, committed: commit === 'true' });
      }
      throw new Error(`Unexpected adapter action: ${action}`);
    },
  };
}
