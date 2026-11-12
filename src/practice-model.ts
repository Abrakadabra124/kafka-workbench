export type PracticeId = 'poison-quarantine' | 'isr-write-gate' | 'retention-gap';
export type PracticeAction =
  'fault' | 'inspect' | 'wrong1' | 'wrong2' | 'repair' | 'verify' | 'reset';
export type PracticeModel = {
  id: PracticeId;
  fault: boolean;
  inspected: boolean;
  repaired: boolean;
  verified: boolean;
  source: string[];
  processed: string[];
  quarantine: string[];
  recovered: string[];
  position: number;
  committed: number;
  start: number;
  isr: number;
  minIsr: number;
  attempts: number;
  message: string;
};
export function initialPractice(id: PracticeId): PracticeModel {
  return {
    id,
    fault: false,
    inspected: false,
    repaired: false,
    verified: false,
    source: ['E0', 'E1', 'E2'],
    processed: [],
    quarantine: [],
    recovered: [],
    position: 0,
    committed: 0,
    start: 0,
    isr: 3,
    minIsr: id === 'isr-write-gate' ? 3 : 2,
    attempts: 0,
    message: 'Три события сохранены. Воспроизведите сбой и исследуйте последствия.',
  };
}
export function practiceTransition(s: PracticeModel, action: PracticeAction): PracticeModel {
  if (action === 'reset') return initialPractice(s.id);
  const n = structuredClone(s);
  n.verified = false;
  if (action === 'fault') {
    if (s.fault) return { ...s, message: 'Сбой уже воспроизведён. Сброс начнёт новую попытку.' };
    n.fault = true;
    if (s.id === 'poison-quarantine') {
      n.processed = ['E0'];
      n.position = 1;
      n.committed = 1;
      n.message = 'E0 обработан. На offset 1 повреждён payload E1. E2 ждёт за ним.';
    }
    if (s.id === 'isr-write-gate') {
      n.isr = 2;
      n.message =
        'ISR=2 при minISR=3. Producer получает NotEnoughReplicas. Чтение доступного журнала не заблокировано.';
    }
    if (s.id === 'retention-gap') {
      n.source = ['E1', 'E2'];
      n.start = 1;
      n.message = 'E0 удалён. Offset 0 ниже log start 1. Архив из трёх событий сохранён отдельно.';
    }
    return n;
  }
  if (!s.fault) return { ...s, message: 'Сначала воспроизведите сбой этой модели.' };
  if (action === 'inspect') {
    n.inspected = true;
    n.message =
      s.id === 'poison-quarantine'
        ? 'Наблюдение: E1 содержит {broken, offset=1. Повтор чтения не меняет payload.'
        : s.id === 'isr-write-gate'
          ? 'Наблюдение: ISR=' +
            s.isr +
            ', minISR=' +
            s.minIsr +
            ', acks=all. Кворум контроллеров и гарантия записи различаются.'
          : 'Наблюдение: start=1, end=3, архив=E0/E1/E2. Доступный хвост не содержит E0.';
    return n;
  }
  if (action === 'verify') {
    n.verified =
      s.inspected &&
      s.repaired &&
      (s.id === 'poison-quarantine'
        ? s.quarantine.length === 1 && s.processed.length === 2 && s.committed === 3
        : s.id === 'isr-write-gate'
          ? s.isr === 3 && s.minIsr === 3 && s.source.includes('proof')
          : s.recovered.join() === 'E0,E1,E2');
    n.message = n.verified
      ? 'Модель восстановлена: критерии выполнены. Теперь подтвердите механизм на настоящем стенде ниже.'
      : 'Проверка не пройдена: наблюдение, безопасное исправление и полнота результата обязательны.';
    return n;
  }
  if (!s.inspected)
    return { ...s, message: 'Сначала исследуйте причину. Решение должно опираться на наблюдение.' };
  if (s.repaired && action !== 'repair')
    return {
      ...s,
      message:
        'Исправление уже применено. Проверьте результат или сбросьте модель для нового эксперимента.',
    };
  n.attempts++;
  if (action === 'repair') {
    n.repaired = true;
    if (s.id === 'poison-quarantine') {
      n.quarantine = ['E1'];
      n.processed = ['E0', 'E2'];
      n.position = 3;
      n.committed = 3;
      n.message =
        'Исходный E1 сохранён с координатой 0:1, E0/E2 обработаны. Затем commit=3. Повтор использует ту же координату.';
    }
    if (s.id === 'isr-write-gate') {
      n.isr = 3;
      n.minIsr = 3;
      n.source = [...s.source.filter((x) => x !== 'proof'), 'proof'];
      n.message =
        'Реплика догнала журнал. ISR=3, minISR=3; контрольная запись подтверждена с acks=all.';
    }
    if (s.id === 'retention-gap') {
      n.recovered = ['E0', 'E1', 'E2'];
      n.message =
        'Архив восстановлен в recovery topic. Исходный E0 в source по-прежнему отсутствует; новые координаты принадлежат другому журналу.';
    }
    return n;
  }
  n.repaired = false;
  if (s.id === 'poison-quarantine') {
    if (action === 'wrong1') {
      n.committed = 3;
      n.position = 3;
      n.message =
        'Commit=end скрывает lag, но не сохраняет E1 и не обрабатывает E2. Нулевой lag не доказывает полноту.';
    } else
      n.message =
        s.committed === 3
          ? 'После commit=end consumer уже в конце и не читает E1. Пропущенные эффекты не восстановлены.'
          : 'Повтор без изменения payload снова встречает E1. Количество попыток растёт, обработка не продвигается.';
  } else if (s.id === 'isr-write-gate') {
    if (action === 'wrong1') {
      n.minIsr = 2;
      n.message =
        'minISR=2 разрешает запись при двух репликах, но ослабляет исходную гарантию. Реплика не восстановлена.';
    } else if (s.minIsr === 2) {
      if (!n.source.includes('weak-write')) n.source.push('weak-write');
      n.message =
        'С minISR=2 повторная запись принята двумя репликами. Доступность вернулась, исходная гарантия трёх реплик нарушена.';
    } else
      n.message =
        'Повтор с прежними acks и minISR не добавляет реплику. Недостаточный ISR остаётся причиной отказа.';
  } else {
    if (action === 'wrong1') {
      n.committed = 3;
      n.position = 3;
      n.message =
        'latest переместил offset в конец. E0 всё ещё потерян, восстановление не выполнено.';
    } else {
      n.recovered = ['E1', 'E2'];
      n.position = 3;
      n.message = 'earliest прочитал только E1/E2. Повтор доступного хвоста не восстановил E0.';
    }
  }
  return n;
}
