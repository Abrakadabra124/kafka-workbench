import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runDockerCommand } from './lab.mjs';
import { acquireHardwareLock } from './hardware-lock.mjs';
import { practiceTasks, isPractice, executePractice } from './practice-workspace.mjs';

const composeFile = fileURLToPath(new URL('../labs/workspace.yaml', import.meta.url));
export const workspaceTasks = [
  {
    id: 'delivery',
    title: 'Доставка без потери',
    description:
      'Запишите заказы в три партиции. Прочитайте их группой orders и исправьте commit в рецепте, чтобы после нового запуска lag остался нулевым.',
    hint: 'Чтение не сохраняет позицию само по себе. После обработки включите consumer.commit и прочитайте заново.',
    consequence:
      'Без commit после перезапуска записи придут повторно. Commit до обработки может привести к пропуску работы.',
  },
  {
    id: 'replay',
    title: 'Почему событие пришло дважды',
    description:
      'Запишите серию. Дважды прочитайте её без commit: каждый запуск создаёт новый consumer. Затем сохраните позицию и докажите восстановление.',
    hint: 'Оставьте commit=false для первых двух чтений, сравните partition/offset, затем включите commit. Новая группа не исправляет offsets группы orders.',
    consequence:
      'Повторная доставка требует идемпотентного обработчика. Сам commit не отменяет уже выполненную внешнюю операцию.',
  },
  {
    id: 'recovery',
    title: 'Брокер недоступен',
    description:
      'Отключите broker 3, наблюдайте уменьшение ISR. Запишите заказы при отказе, восстановите брокер, прочитайте данные и проверьте все реплики.',
    hint: 'При RF=3 и min.insync.replicas=2 запись acks=all переживает один отказ. Восстановление подтверждается ISR=3 для каждой партиции.',
    consequence:
      'Второй отказ может остановить запись. Уменьшение min.insync.replicas ослабляет гарантию сохранности и не восстанавливает реплики.',
  },
  ...practiceTasks,
];
export const workspaceActions = [
  'save',
  'prepare',
  'produce',
  'consume',
  'inspect',
  'verify',
  'fault',
  'recover',
  'stop',
  'unsafe',
  'retry',
  'interrupt',
];
export function defaultRecipe() {
  return JSON.stringify(
    {
      records: [
        { partition: 0, key: 'customer-42', value: 'Заказ ORD-201' },
        { partition: 1, key: 'customer-7', value: 'Заказ ORD-202' },
        { partition: 2, key: 'customer-42', value: 'Заказ ORD-203' },
      ],
      consumer: { group: 'orders', maxRecords: 3, commit: false },
    },
    null,
    2,
  );
}
function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((k) => keys.includes(k))
  );
}
export function parseRecipe(text) {
  if (typeof text !== 'string' || text.length > 16000)
    throw new Error('Рецепт должен быть JSON длиной до 16000 символов.');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Не удалось разобрать JSON. Проверьте кавычки, запятые и скобки.');
  }
  if (
    !exactKeys(value, ['records', 'consumer']) ||
    !Array.isArray(value.records) ||
    value.records.length < 1 ||
    value.records.length > 12
  )
    throw new Error('Нужны records (1..12 записей) и consumer. Другие поля не поддерживаются.');
  for (const r of value.records) {
    if (
      !exactKeys(r, ['partition', 'key', 'value']) ||
      !Number.isInteger(r.partition) ||
      r.partition < 0 ||
      r.partition > 2 ||
      !['key', 'value'].every(
        (k) =>
          typeof r[k] === 'string' &&
          r[k].length > 0 &&
          r[k].length <= 512 &&
          !/[\u0000-\u001f]/u.test(r[k]),
      )
    )
      throw new Error(
        'Запись: partition 0..2, непустые key/value до 512 символов без управляющих знаков.',
      );
  }
  const c = value.consumer;
  if (
    !exactKeys(c, ['group', 'maxRecords', 'commit']) ||
    !['orders', 'audit'].includes(c.group) ||
    !Number.isInteger(c.maxRecords) ||
    c.maxRecords < 1 ||
    c.maxRecords > 36 ||
    typeof c.commit !== 'boolean'
  )
    throw new Error('consumer: group orders/audit, maxRecords 1..36, commit true/false.');
  return value;
}
export function emptyWorkspaceState() {
  return {
    draft: defaultRecipe(),
    attempt: 0,
    prepared: false,
    snapshot: null,
    history: [],
    ledger: [],
    reads: [],
    faultObserved: false,
    wroteDuringFault: false,
    verified: false,
  };
}
const identity = (r) => JSON.stringify([r.partition, r.offset, r.key, r.value]);
export function evaluateWorkspace(id, state, snapshot, records) {
  const expected = new Set(state.ledger.map(identity));
  const actual = new Set(records.map(identity));
  const read = new Set(
    state.readEvidence ??
      state.reads.filter((r) => r.group === 'orders').flatMap((r) => r.records.map(identity)),
  );
  const checks = [
    { label: 'Есть подтверждённая серия заказов', ok: expected.size > 0 },
    {
      label: 'Независимое чтение совпало с журналом отправки',
      ok:
        expected.size > 0 &&
        actual.size === expected.size &&
        [...expected].every((k) => actual.has(k)) &&
        snapshot.partitions.reduce((s, p) => s + p.end, 0) === expected.size,
    },
    {
      label: 'Группа orders прочитала всю серию',
      ok: expected.size > 0 && [...expected].every((k) => read.has(k)),
    },
    {
      label: 'Сохранённые offsets orders совпадают с концом журнала',
      ok: snapshot.partitions.every((p) => (p.committed ?? 0) === p.end),
    },
    {
      label: 'Три реплики синхронны для каждой партиции',
      ok: snapshot.partitions.every(
        (p) => p.replicas.length === 3 && p.isr.length === 3 && p.leader > 0,
      ),
    },
  ];
  if (id === 'replay') {
    const seen = new Set();
    let duplicate = false;
    for (const r of state.reads.filter((r) => r.group === 'orders' && !r.committed))
      for (const row of r.records) {
        if (seen.has(identity(row))) duplicate = true;
        seen.add(identity(row));
      }
    checks.push({
      label: 'Повтор одного offset без commit наблюдался в двух чтениях',
      ok: duplicate || state.replayObserved === true,
    });
  }
  if (id === 'recovery')
    checks.push({
      label: 'Отказ наблюдался и запись при уменьшенном ISR подтверждена',
      ok: state.faultObserved && state.wroteDuringFault,
    });
  return { passed: checks.every((c) => c.ok), checks };
}
function containers(text) {
  if (!text.trim()) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [v];
  } catch {
    return text
      .trim()
      .split(/\r?\n/u)
      .map((l) => JSON.parse(l));
  }
}
function labelsOf(container) {
  return typeof container.Labels === 'object'
    ? container.Labels
    : Object.fromEntries(
        String(container.Labels ?? '')
          .split(/,(?=[\w./-]+=)/u)
          .map((v) => {
            const i = v.indexOf('=');
            return [v.slice(0, i), v.slice(i + 1)];
          }),
      );
}
export function createWorkspaceRunner({
  store,
  runCommand = runDockerCommand,
  testMode = false,
  hardwareLock = true,
} = {}) {
  const project = testMode ? 'kafka-workbench-workspace-test' : 'kafka-workbench-workspace';
  const prefix = ['compose', '--project-name', project, '--file', composeFile];
  const compose = (args, options) =>
    runCommand([...prefix, ...args], {
      ...options,
      env: {
        ...process.env,
        KAFKA_WORKSPACE_SUBNET: testMode
          ? (process.env.KAFKA_WORKSPACE_TEST_SUBNET ?? '10.254.244.16/28')
          : (process.env.KAFKA_WORKSPACE_SUBNET ?? '10.254.244.0/28'),
      },
    });
  let busy = null;
  // Kept only for retries in this process. After a restart we never adopt
  // unknown orphan volumes merely because their names look anonymous.
  const pendingVolumes = new Map();
  const normalizePath = (path) =>
    process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const dockerId = /^[a-f0-9]{64}$/u;
  const load = (id) => store.workspace(id) ?? emptyWorkspaceState();
  const checked = async (promise) => {
    const r = await promise;
    if (r.code !== 0 || r.timedOut || r.outputLimited)
      throw new Error(
        (r.timedOut ? 'Истекло время ожидания. ' : '') +
          [r.stdout, r.stderr].filter(Boolean).join('\n').slice(-6000),
      );
    return r;
  };
  async function owned() {
    let inspection;
    try {
      // The first Compose plugin invocation can exceed five seconds on a cold CI runner.
      // This read-only probe stays bounded and must succeed before any mutation.
      inspection = await checked(
        compose(['ps', '--all', '--no-trunc', '--format', 'json'], { timeoutMs: 15000 }),
      );
    } catch (error) {
      throw new Error(`Не удалось проверить принадлежность стенда: ${error.message}`);
    }
    const list = containers(inspection.stdout);
    for (const c of list) {
      const path = labelsOf(c)['com.docker.compose.project.config_files'];
      if (
        !path ||
        normalizePath(path) !== normalizePath(composeFile) ||
        !['broker1', 'broker2', 'broker3'].includes(c.Service)
      )
        throw new Error(
          `Стенд принадлежит другому checkout. Его ресурсы не изменены. Service=${c.Service}; source=${JSON.stringify(path)}; expected=${JSON.stringify(composeFile)}.`,
        );
    }
    return list;
  }
  async function inspectJson(args) {
    const output = await checked(runCommand(args, { timeoutMs: 15000, maxOutputBytes: 262144 }));
    let rows;
    try {
      rows = JSON.parse(output.stdout);
    } catch {
      throw new Error('Docker вернул неполную проверку принадлежности ресурсов.');
    }
    if (!Array.isArray(rows)) throw new Error('Docker не вернул список проверяемых ресурсов.');
    return rows;
  }
  function volumeSignature(volume, name) {
    const labels = volume?.Labels ?? {};
    if (
      volume?.Name !== name ||
      !dockerId.test(name) ||
      volume.Driver !== 'local' ||
      volume.Scope !== 'local' ||
      typeof volume.CreatedAt !== 'string' ||
      Number.isNaN(Date.parse(volume.CreatedAt)) ||
      typeof volume.Mountpoint !== 'string' ||
      !volume.Mountpoint ||
      typeof labels !== 'object' ||
      Array.isArray(labels) ||
      (volume.Options != null &&
        (typeof volume.Options !== 'object' ||
          Array.isArray(volume.Options) ||
          Object.keys(volume.Options).length)) ||
      Object.hasOwn(labels, 'com.docker.compose.volume') ||
      (labels['com.docker.compose.project'] && labels['com.docker.compose.project'] !== project)
    )
      throw new Error(`Не подтверждён анонимный локальный том стенда: ${name}.`);
    return JSON.stringify([
      volume.Name,
      volume.Driver,
      volume.Scope,
      volume.CreatedAt,
      volume.Mountpoint,
      Object.entries(labels).sort(),
    ]);
  }
  async function volumeMetadata(name) {
    const rows = await inspectJson(['volume', 'inspect', name]);
    if (rows.length !== 1) throw new Error(`Неполная проверка тома ${name}.`);
    return { metadata: rows[0], signature: volumeSignature(rows[0], name) };
  }
  async function volumeExists(name) {
    const result = await checked(
      runCommand(['volume', 'ls', '--filter', `name=${name}`, '--format', '{{.Name}}'], {
        timeoutMs: 15000,
      }),
    );
    const names = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
    if (names.some((value) => value !== name) || names.length > 1)
      throw new Error(`Неоднозначный результат поиска тома ${name}.`);
    return names.length === 1;
  }
  async function volumeReferences(name, allowed, required = []) {
    const result = await checked(
      runCommand(
        ['ps', '--all', '--no-trunc', '--filter', `volume=${name}`, '--format', '{{.ID}}'],
        { timeoutMs: 15000 },
      ),
    );
    const ids = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
    if (
      ids.some((id) => !dockerId.test(id) || !allowed.has(id)) ||
      required.some((id) => !ids.includes(id))
    )
      throw new Error(
        `Том ${name} использует чужой контейнер или его принадлежность изменилась. Ресурсы не удалены.`,
      );
  }
  async function captureVolumes(list) {
    const ids = list.map((container) => container.ID);
    if (
      list.length > 3 ||
      ids.some((id) => typeof id !== 'string' || !dockerId.test(id)) ||
      new Set(ids).size !== ids.length
    )
      throw new Error('Не удалось подтвердить полный список ID контейнеров стенда.');
    if (!ids.length) return new Map();
    const details = await inspectJson(['inspect', '--type', 'container', ...ids]);
    if (
      details.length !== ids.length ||
      new Set(details.map((c) => c.Id)).size !== ids.length ||
      details.some((c) => !ids.includes(c.Id))
    )
      throw new Error('Docker вернул неполный или повторяющийся список контейнеров.');
    const volumes = new Map();
    const images = new Map();
    for (const container of details) {
      const labels = container.Config?.Labels;
      const service = list.find((c) => c.ID === container.Id).Service;
      const host = container.HostConfig;
      if (
        !labels ||
        labels['com.docker.compose.project'] !== project ||
        labels['com.docker.compose.service'] !== service ||
        typeof labels['com.docker.compose.project.config_files'] !== 'string' ||
        normalizePath(labels['com.docker.compose.project.config_files']) !==
          normalizePath(composeFile)
      )
        throw new Error('Проверка inspect обнаружила контейнер другого checkout или проекта.');
      if (
        !host ||
        [host.Binds, host.VolumesFrom].some(
          (value) => value != null && (!Array.isArray(value) || value.length),
        ) ||
        (host.Mounts != null && !Array.isArray(host.Mounts)) ||
        !Array.isArray(container.Mounts) ||
        container.Mounts.length > 12
      )
        throw new Error(
          'У стенда обнаружены неподдерживаемые пользовательские подключения данных.',
        );
      if (!container.Mounts.length) {
        if (host.Mounts?.length)
          throw new Error('Список подключений контейнера не совпал с inspect.');
        continue;
      }
      if (typeof container.Image !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(container.Image))
        throw new Error('Не удалось подтвердить ID образа контейнера.');
      if (!images.has(container.Image)) {
        const rows = await inspectJson(['image', 'inspect', container.Image]);
        if (
          rows.length !== 1 ||
          rows[0].Id !== container.Image ||
          !rows[0].Config?.Volumes ||
          typeof rows[0].Config.Volumes !== 'object' ||
          Array.isArray(rows[0].Config.Volumes)
        )
          throw new Error('Не удалось подтвердить VOLUME, объявленные образом Kafka.');
        images.set(container.Image, rows[0].Config.Volumes);
      }
      const declared = images.get(container.Image);
      for (const mount of container.Mounts) {
        if (
          mount.Type !== 'volume' ||
          typeof mount.Name !== 'string' ||
          !dockerId.test(mount.Name) ||
          !Object.hasOwn(declared, mount.Destination)
        )
          throw new Error('Том не является разрешённым анонимным VOLUME образа Kafka.');
        const explicit = (host.Mounts ?? []).filter((m) => m.Target === mount.Destination);
        if (explicit.length > 1) throw new Error('Неоднозначные подключения тома контейнера.');
        if (!volumes.has(mount.Name))
          volumes.set(mount.Name, { ...(await volumeMetadata(mount.Name)), owners: [] });
        const volume = volumes.get(mount.Name);
        if (explicit.length) {
          const entry = explicit[0];
          // Compose may inherit an image's anonymous volume on recreation.
          // An explicit source is accepted only with Docker's anonymous label.
          if (
            entry.Type !== 'volume' ||
            entry.Source !== mount.Name ||
            entry.ReadOnly === true ||
            Object.keys(entry).some(
              (key) =>
                !['Type', 'Source', 'Target', 'ReadOnly', 'Consistency', 'VolumeOptions'].includes(
                  key,
                ),
            ) ||
            (entry.Consistency && entry.Consistency !== 'default') ||
            (entry.VolumeOptions != null &&
              (typeof entry.VolumeOptions !== 'object' ||
                Array.isArray(entry.VolumeOptions) ||
                Object.keys(entry.VolumeOptions).some((key) => key !== 'NoCopy') ||
                entry.VolumeOptions.NoCopy === true)) ||
            !Object.hasOwn(volume.metadata.Labels ?? {}, 'com.docker.volume.anonymous')
          )
            throw new Error('Явное подключение не подтверждено как унаследованный анонимный том.');
        }
        volume.owners.push(container.Id);
      }
      if (
        (host.Mounts ?? []).some(
          (entry) => !container.Mounts.some((mount) => mount.Destination === entry.Target),
        )
      )
        throw new Error('Пользовательское подключение не совпадает с томами образа.');
    }
    return volumes;
  }
  async function stopWorkspace() {
    const list = await owned();
    const ids = new Set(list.map((container) => container.ID));
    const captured = await captureVolumes(list);
    for (const [name, volume] of captured) {
      if (pendingVolumes.has(name) && pendingVolumes.get(name).signature !== volume.signature)
        throw new Error(`Захваченный ранее том ${name} был заменён.`);
    }
    const candidates = new Map([...pendingVolumes, ...captured]);
    // Check every candidate before the first mutation, including stopped users
    // outside this project. Do not trust the hash-like name by itself.
    for (const [name, volume] of candidates) {
      if (!(await volumeExists(name))) {
        candidates.delete(name);
        pendingVolumes.delete(name);
        continue;
      }
      if ((await volumeMetadata(name)).signature !== volume.signature)
        throw new Error(`Метаданные тома ${name} изменились.`);
      await volumeReferences(name, ids, captured.get(name)?.owners ?? []);
    }
    const current = await owned();
    if (current.length !== ids.size || current.some((container) => !ids.has(container.ID)))
      throw new Error('Список контейнеров изменился во время проверки очистки.');
    for (const [name, volume] of candidates) pendingVolumes.set(name, volume);
    await checked(compose(['down', '--volumes', '--timeout', '15'], { timeoutMs: 60000 }));
    if ((await owned()).length) throw new Error('Контейнеры стенда ещё существуют.');
    for (const [name, volume] of pendingVolumes) {
      if (await volumeExists(name)) {
        if ((await volumeMetadata(name)).signature !== volume.signature)
          throw new Error(`Том ${name} был заменён после остановки.`);
        await volumeReferences(name, new Set());
        // No --force: Docker itself must also reject a new attachment racing
        // this check. Never select orphaned or unrelated volumes for cleanup.
        await checked(runCommand(['volume', 'rm', name], { timeoutMs: 15000 }));
        if (await volumeExists(name)) throw new Error(`Удаление тома ${name} не подтверждено.`);
      }
      pendingVolumes.delete(name);
    }
  }
  async function adapter(
    action,
    id,
    { group = 'orders', maxRecords = 36, commit = false, records } = {},
  ) {
    const topic = `wb-${id}`;
    const input = records
      ?.map((r) =>
        [
          r.partition,
          Buffer.from(r.key).toString('base64'),
          Buffer.from(r.value).toString('base64'),
        ].join('\t'),
      )
      .join('\n');
    const r = await checked(
      compose(
        [
          'exec',
          '-T',
          'broker1',
          'java',
          '--class-path',
          '/opt/kafka/libs/*:/opt/workbench',
          'Workbench',
          action,
          topic,
          `${topic}-${group}`,
          String(maxRecords),
          String(commit),
        ],
        {
          input: input === undefined ? undefined : input + '\n',
          timeoutMs: 60000,
          maxOutputBytes: 262144,
        },
      ),
    );
    try {
      return JSON.parse(r.stdout.trim());
    } catch {
      throw new Error('Kafka не вернула ожидаемый структурированный результат. Проверьте стенд.');
    }
  }
  async function snapshot(id) {
    const state = await adapter('snapshot', id);
    const list = await owned();
    return {
      ...state,
      capturedAt: new Date().toISOString(),
      brokers: [1, 2, 3].map((n) => ({
        id: n,
        running: list.some((c) => c.Service === `broker${n}` && c.State === 'running'),
      })),
    };
  }
  async function healthy(id) {
    for (let i = 0; i < 12; i++) {
      const s = await snapshot(id);
      if (s.partitions.every((p) => p.isr.length === 3 && p.leader > 0)) return s;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(
      'Брокеры запущены, но синхронизация всех трёх реплик ещё не подтверждена. Повторите инспекцию.',
    );
  }
  async function status() {
    const r = await runCommand(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 5000 });
    return {
      available: r.code === 0 && !!r.stdout.trim() && !r.timedOut,
      busy,
      tasks: workspaceTasks,
      states: Object.fromEntries(workspaceTasks.map((t) => [t.id, load(t.id)])),
    };
  }
  async function execute(id, action, draft) {
    if (!workspaceTasks.some((t) => t.id === id) || !workspaceActions.includes(action))
      return { ok: false, httpStatus: 400, error: 'Неизвестное задание или действие.' };
    if (busy)
      return { ok: false, httpStatus: 409, error: 'Дождитесь завершения текущей операции.' };
    let recipe;
    const usesRecipe = ['save', 'prepare', 'produce', 'consume'].includes(action);
    try {
      if (usesRecipe && draft !== undefined) recipe = parseRecipe(draft);
    } catch (e) {
      return { ok: false, httpStatus: 400, error: e.message };
    }
    let state = load(id),
      release;
    if (usesRecipe && draft !== undefined) state.draft = draft;
    if (action === 'save') {
      store.saveWorkspace(id, state);
      return { ok: true, state };
    }
    busy = { id, action, startedAt: new Date().toISOString() };
    const startedAt = busy.startedAt;
    try {
      if (hardwareLock) release = await acquireHardwareLock();
      if (usesRecipe) recipe ??= parseRecipe(state.draft);
      await owned();
      let result = {},
        message = '';
      if (action === 'prepare') {
        state = {
          ...emptyWorkspaceState(),
          draft: state.draft,
          attempt: state.attempt + 1,
          history: state.history,
        };
        store.saveWorkspace(id, state);
        await checked(compose(['build', '--quiet', 'broker1'], { timeoutMs: 300000 }));
        await checked(
          compose(['up', '-d', '--quiet-pull', '--wait', '--wait-timeout', '150'], {
            timeoutMs: 240000,
          }),
        );
        if (isPractice(id)) {
          const prepared = await executePractice({
            id,
            action,
            state,
            adapter,
            snapshot,
            healthy,
            compose,
            checked,
          });
          result = prepared.result;
          message = prepared.message;
        } else await adapter('prepare', id);
        state.snapshot = await healthy(id);
        state.prepared = true;
        if (!isPractice(id))
          message =
            'Выделенный topic подготовлен: 3 партиции, RF=3, min ISR=2. Предыдущая попытка этого задания очищена, история сохранена.';
      } else if (action === 'stop') {
        await stopWorkspace();
        for (const task of workspaceTasks) {
          const old = load(task.id);
          store.saveWorkspace(task.id, {
            ...old,
            prepared: false,
            snapshot: null,
            verified: false,
          });
        }
        state = load(id);
        message = 'Только новый стенд удалён. Черновики, история и учебный прогресс сохранены.';
      } else {
        if (!state.prepared) throw new Error('Сначала подготовьте стенд для этого задания.');
        state.verified = false;
        if (isPractice(id)) {
          const executed = await executePractice({
            id,
            action,
            state,
            adapter,
            snapshot,
            healthy,
            compose,
            checked,
          });
          result = executed.result;
          message = executed.message;
        } else if (action === 'produce') {
          if (state.ledger.length + recipe.records.length > 36)
            throw new Error(
              'Лимит попытки: 36 событий. Подготовьте новую попытку для продолжения.',
            );
          result = await adapter('produce', id, { records: recipe.records });
          state.ledger.push(...result.records);
          state.snapshot = await snapshot(id);
          if (state.faultObserved && state.snapshot.partitions.some((p) => p.isr.length < 3))
            state.wroteDuringFault = true;
          message = `Запись подтверждена Kafka: ${result.records.length} событий. Это ещё не зачёт задания.`;
        } else if (action === 'consume') {
          result = await adapter('consume', id, recipe.consumer);
          if (recipe.consumer.group === 'orders') {
            const previouslyRead =
              state.readEvidence ??
              state.reads
                .filter((r) => r.group === 'orders')
                .flatMap((r) => r.records.map(identity));
            state.readEvidence = [
              ...new Set([...previouslyRead, ...result.records.map(identity)]),
            ].slice(0, 36);
            if (!recipe.consumer.commit) {
              const previous = new Set(
                state.uncommittedEvidence ??
                  state.reads
                    .filter((r) => r.group === 'orders' && !r.committed)
                    .flatMap((r) => r.records.map(identity)),
              );
              state.replayObserved ||= result.records.some((r) => previous.has(identity(r)));
              state.uncommittedEvidence = [
                ...new Set([...previous, ...result.records.map(identity)]),
              ].slice(0, 36);
            }
          }
          state.reads.push({ ...result, group: recipe.consumer.group });
          state.reads = state.reads.slice(-24);
          state.snapshot = await snapshot(id);
          message = `Прочитано ${result.records.length}. Commit: ${recipe.consumer.commit ? 'включён' : 'выключен'}. Группа: ${recipe.consumer.group}.`;
        } else if (action === 'fault') {
          if (id !== 'recovery')
            throw new Error('Отключение брокера доступно в задании восстановления.');
          await checked(compose(['stop', '--timeout', '10', 'broker3'], { timeoutMs: 45000 }));
          state.snapshot = await snapshot(id);
          state.faultObserved =
            state.snapshot.brokers.some((b) => b.id === 3 && !b.running) &&
            state.snapshot.partitions.some((p) => p.isr.length < 3);
          if (!state.faultObserved)
            throw new Error(
              'Остановка отправлена, но уменьшение ISR ещё не подтверждено. Повторите отключение/инспекцию.',
            );
          message =
            'Сбой воспроизведён: broker 3 остановлен, ISR уменьшился. Запишите события, затем восстановите брокер.';
        } else if (action === 'recover') {
          await checked(compose(['start', 'broker3'], { timeoutMs: 30000 }));
          state.snapshot = await healthy(id);
          message = 'Восстановление подтверждено: все три реплики снова в ISR.';
        } else if (action === 'inspect') {
          state.snapshot = await snapshot(id);
          message = 'Свежий снимок прочитан из Kafka. Непрерывный мониторинг не включён.';
        } else if (action === 'verify') {
          state.snapshot = await snapshot(id);
          const observed = await adapter('read-all', id, {
            maxRecords: Math.min(
              37,
              Math.max(
                1,
                state.snapshot.partitions.reduce((n, p) => n + p.end, 0),
              ),
            ),
            group: 'audit',
          });
          result = evaluateWorkspace(id, state, state.snapshot, observed.records);
          state.verified = result.passed;
          message = result.passed
            ? 'Результат независимо проверен. Задание выполнено.'
            : 'Задание пока не зачтено. Исправьте пункты проверки и повторите.';
        }
      }
      const event = {
        id: crypto.randomUUID(),
        action,
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: true,
        message,
        result,
        snapshot: state.snapshot,
      };
      state.history = [...state.history, event].slice(-48);
      store.saveWorkspace(id, state);
      return { ok: true, state, event };
    } catch (e) {
      state.verified = false;
      const event = {
        id: crypto.randomUUID(),
        action,
        startedAt,
        finishedAt: new Date().toISOString(),
        ok: false,
        message: e.message.slice(0, 6500),
        result: {},
        snapshot: null,
      };
      state.history = [...state.history, event].slice(-48);
      store.saveWorkspace(id, state);
      return { ok: false, httpStatus: 503, error: event.message, state, event };
    } finally {
      busy = null;
      if (release) await release();
    }
  }
  return { status, execute };
}
