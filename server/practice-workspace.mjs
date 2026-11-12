export const practiceTasks = [
  {
    id: 'poison-quarantine',
    title: 'Poison pill и карантин',
    practice: true,
    description:
      'Повреждённая запись блокирует обработку. Докажите причину, сохраните исходные байты и координаты в карантине, затем продолжите партицию.',
    hint: 'Пропуск с commit скрывает lag, но теряет материал для расследования. Сначала подтверждение карантина, потом commit.',
    consequence:
      'Повтор между карантином и commit должен опираться на исходную координату. Карантин не отменяет необходимость разбора события.',
  },
  {
    id: 'isr-write-gate',
    title: 'ISR и отказ записи',
    practice: true,
    description:
      'RF=3, minISR=3, acks=all. Один брокер недоступен: контроллеры имеют кворум, но producer не получает требуемую гарантию.',
    hint: 'Проверьте ошибку producer, состав ISR и конфигурацию topic. Восстановите реплику, сохранив minISR=3.',
    consequence:
      'Уменьшение minISR может вернуть запись, но меняет требование сохранности. Timeout сам по себе не доказывает отсутствие записи.',
  },
  {
    id: 'retention-gap',
    title: 'Утраченная история',
    practice: true,
    description:
      'Сохранённый offset ниже log start после удаления части только учебного topic. Потребителю нужна явная политика восстановления.',
    hint: 'Сравните beginning, committed и end. Архив создан до удаления. Восстановите business IDs и payload в отдельный recovery topic.',
    consequence:
      'Сброс offset в конец даёт нулевой lag, но не возвращает утраченную работу. У восстановленных событий будут новые Kafka-координаты.',
  },
];
export const isPractice = (id) => practiceTasks.some((task) => task.id === id);
const identity = (r) => JSON.stringify([r.key, r.value]);
const sameRecords = (actual, expected) =>
  Array.isArray(actual) &&
  actual.length === expected.length &&
  JSON.stringify(actual.map(identity).sort()) === JSON.stringify(expected.map(identity).sort());

/** Evidence comes from independent Kafka reads, never from a submitted success flag. */
export function evaluatePractice(id, state, snapshot, evidence) {
  const archive = state.archive ?? [];
  const checks = [
    {
      label: 'Сбой этой попытки наблюдался до восстановления',
      ok: state.faultObserved === true && state.recoveryAcknowledged === true,
    },
    { label: 'Исходная подтверждённая серия сохранена', ok: archive.length === 3 },
    {
      label: 'Все три реплики синхронны',
      ok:
        snapshot.partitions.length === 3 &&
        snapshot.partitions.every(
          (p) => p.isr.length === 3 && p.replicas.length === 3 && p.leader > 0,
        ),
    },
  ];
  if (id === 'poison-quarantine') {
    const bad = archive.find((r) => r.key === 'E1');
    let quarantined;
    try {
      quarantined = evidence.quarantine?.map((r) => JSON.parse(r.value));
    } catch {
      quarantined = [];
    }
    checks.push(
      {
        label: 'Ошибка контракта наблюдалась на реальной записи',
        ok: state.faultCode === 'SchemaViolation',
      },
      {
        label: 'Корректные события обработаны ровно по одному разу',
        ok: sameRecords(
          evidence.processed,
          archive.filter((r) => r.key !== 'E1'),
        ),
      },
      {
        label: 'Карантин сохранил исходные байты, координаты и причину',
        ok:
          !!bad &&
          quarantined?.length === 1 &&
          quarantined[0].sourceTopic === 'wb-poison-quarantine' &&
          quarantined[0].partition === bad.partition &&
          quarantined[0].offset === bad.offset &&
          quarantined[0].payload === bad.value &&
          quarantined[0].reason === 'SCHEMA_VIOLATION',
      },
      {
        label: 'Commit выполнен после обработки всей исходной серии',
        ok: snapshot.partitions.every((p) => (p.committed ?? 0) === p.end),
      },
    );
  } else if (id === 'isr-write-gate') {
    checks.push(
      {
        label: 'Kafka действительно отклонила запись из-за недостаточного ISR',
        ok: ['NotEnoughReplicasException', 'NotEnoughReplicasAfterAppendException'].includes(
          state.faultCode,
        ),
      },
      { label: 'Исходная гарантия minISR=3 сохранена', ok: evidence.minIsr === 3 },
      {
        label: 'Контрольная запись после восстановления подтверждена и прочитана',
        ok:
          !!state.proof &&
          evidence.source?.filter((r) => r.key === 'recovery-proof').length === 1 &&
          evidence.source.some(
            (r) =>
              r.key === state.proof.key &&
              r.value === 'acks=all;minISR=3' &&
              r.offset === state.proof.offset &&
              r.partition === state.proof.partition,
          ),
      },
      {
        label: 'Исходные события не потеряны',
        ok: archive.every((r) => evidence.source?.some((v) => identity(v) === identity(r))),
      },
    );
  } else if (id === 'retention-gap') {
    checks.push(
      {
        label: 'OffsetOutOfRange и исчезновение начала журнала действительно наблюдались',
        ok: state.faultCode === 'OffsetOutOfRangeException' && evidence.start > 0,
      },
      {
        label: 'Архив восстановлен полностью без лишних бизнес-событий',
        ok: sameRecords(evidence.recovered, archive),
      },
    );
  } else checks.push({ label: 'Неизвестная задача', ok: false });
  return { passed: checks.every((c) => c.ok), checks };
}

export async function executePractice({
  id,
  action,
  state,
  adapter,
  snapshot,
  healthy,
  compose,
  checked,
}) {
  let result = {},
    message = '';
  state.verified = false;
  if (action === 'prepare') {
    result = await adapter('practice-prepare', id);
    state.archive = result.records;
    state.ledger = result.records;
    state.faultCode = null;
    state.faultObserved = false;
    state.recoveryAcknowledged = false;
    state.proof = null;
    state.snapshot = await healthy(id);
    message = 'Новая учебная серия подтверждена Kafka. Архив этой попытки сохранён до любого сбоя.';
  } else if (action === 'fault') {
    if (state.faultObserved)
      throw new Error(
        'Сбой уже зафиксирован. Для повторного эксперимента подготовьте новую попытку.',
      );
    state.recoveryAcknowledged = false;
    state.proof = null;
    if (id === 'isr-write-gate') {
      await checked(compose(['stop', '--timeout', '10', 'broker3'], { timeoutMs: 45000 }));
      // Kafka's own metadata is sampled before probing the durability gate.
      for (let attempt = 0; attempt < 12; attempt++) {
        state.snapshot = await snapshot(id);
        if (state.snapshot.partitions.every((p) => p.isr.length === 2)) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!state.snapshot.partitions.every((p) => p.isr.length === 2))
        throw new Error('ISR=2 ещё не подтверждён. Повторите наблюдение.');
    }
    result = await adapter('practice-fault', id);
    state.faultCode = result.code ?? null;
    state.faultObserved = !!result.code;
    state.snapshot = await snapshot(id);
    message = `Наблюдение Kafka: ${result.code ?? 'ожидаемая ошибка не подтверждена'}. ${result.message ?? ''}`;
  } else if (action === 'recover') {
    if (!state.faultObserved)
      throw new Error('Сначала воспроизведите и подтвердите сбой этой попытки.');
    if (id === 'isr-write-gate') {
      await checked(compose(['start', 'broker3'], { timeoutMs: 30000 }));
      await healthy(id);
    }
    result = await adapter('practice-repair', id, { records: state.archive });
    state.recoveryAcknowledged = result.repaired === true;
    if (id === 'isr-write-gate') state.proof = result.proof;
    state.snapshot = await snapshot(id);
    message = 'Исправление выполнено. Независимая проверка результата ещё необходима.';
  } else if (action === 'unsafe') {
    state.recoveryAcknowledged = false;
    result = await adapter('practice-wrong', id);
    state.snapshot = await snapshot(id);
    message =
      id === 'isr-write-gate'
        ? 'minISR снижен до 2. Доступность может вернуться, но исходная гарантия нарушена.'
        : 'Offset передвинут в конец. Это не доказательство сохранения и обработки событий.';
  } else if (action === 'interrupt') {
    if (id !== 'poison-quarantine' || !state.faultObserved)
      throw new Error('Инъекция доступна только после poison-сбоя.');
    state.recoveryAcknowledged = false;
    result = await adapter('practice-interrupt', id);
    state.snapshot = await snapshot(id);
    message =
      'Обработчик остановлен после подтверждения карантина, до commit. Повтор должен сохранить один эффект.';
  } else if (action === 'retry') {
    if (!state.faultObserved) throw new Error('Сначала воспроизведите сбой.');
    state.recoveryAcknowledged = false;
    result = await adapter('practice-retry', id);
    state.snapshot = await snapshot(id);
    message =
      id === 'retention-gap'
        ? 'Прочитан только доступный хвост. Утраченный E0 не восстановлен.'
        : 'Повтор без устранения причины не восстанавливает исходные требования.';
  } else if (action === 'inspect' || action === 'verify') {
    const evidence = await adapter('practice-inspect', id);
    state.snapshot = await snapshot(id);
    result = { evidence };
    if (action === 'verify') {
      Object.assign(result, evaluatePractice(id, state, state.snapshot, evidence));
      state.verified = result.passed;
    }
    message =
      action === 'inspect'
        ? 'Фактические topic, payload и конфигурация прочитаны независимо.'
        : result.passed
          ? 'Все критерии подтверждены Kafka. Задача выполнена.'
          : 'Критерии восстановления пока не выполнены.';
  } else
    throw new Error(
      'Для этой задачи используйте воспроизведение сбоя, наблюдение и выбранное решение.',
    );
  return { result, message };
}
