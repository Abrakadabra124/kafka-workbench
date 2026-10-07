import { incidents } from '../content/incidents.mjs';

const healthyNodes = {
  producer: 'healthy',
  broker: 'healthy',
  consumer: 'healthy',
  external: 'healthy',
};
const metrics = (changes = {}) => ({
  lag: 0,
  inRate: 200,
  outRate: 200,
  isr: 3,
  disk: 64,
  duplicates: 0,
  ...changes,
});
const nodes = (changes = {}) => ({ ...healthyNodes, ...changes });
const models = {
  'lag-growth': {
    hypothesis: 'downstream',
    fix: 'repair-downstream',
    initial: {
      metrics: metrics({ lag: 1200, outRate: 80 }),
      nodes: nodes({ consumer: 'degraded', external: 'degraded' }),
    },
    observations: {
      rates:
        'Вход 200 событий/с, обработка 80 событий/с: backlog растёт примерно на 120 событий/с. Подтверждения producer проходят без ошибок.',
      database:
        'p95 запроса к базе вырос до 900 мс. После недавнего изменения исчез полезный индекс, пул соединений занят; узкое место находится после consumer.',
      assignment:
        'Все 6 партиций назначены, 3 consumer активны. Ошибок rebalance нет. Дополнительные экземпляры будут конкурировать за ту же перегруженную базу.',
    },
    diagnosis:
      'Данные указывают на внешний запрос к базе: broker принимает события, группа стабильна, а скорость downstream ниже входа.',
    wrongHypotheses: {
      'consumer-count':
        'Число consumer само по себе не объясняет деградацию: все назначения действуют, а база уже перегружена. Изучи задержку внешних запросов.',
      'broker-loss':
        'Producer получает подтверждения, конец журнала растёт. Наблюдения не подтверждают потерю всех записей брокером.',
    },
    wrongFixes: {
      'scale-consumers': {
        metrics: { lag: 1560, outRate: 40 },
        nodes: { consumer: 'degraded', external: 'blocked' },
        text: 'Дополнительные consumer усилили конкуренцию за базу. Обработка упала до 40 событий/с, lag вырос. Причину запроса нужно устранить.',
      },
      'reset-latest': {
        metrics: { lag: 0, outRate: 80 },
        text: 'Lag стал нулевым из-за пропуска накопленной работы, но заказы не обработаны. Это ложное улучшение. Перед восстановлением верни точку чтения доступной истории и проверь бизнес-результат.',
      },
    },
    repaired: {
      metrics: { lag: 600, inRate: 100, outRate: 300 },
      nodes: nodes({ consumer: 'degraded' }),
    },
    repairText:
      'Вход временно ограничен, запрос к базе исправлен. При необходимости восстановлена точка чтения доступной истории. Обработка 300 событий/с превышает вход 100; backlog ещё 600. Теперь проверь итог.',
    final: metrics({ inRate: 200, outRate: 200 }),
    verifyText:
      'Контрольный интервал завершён: backlog разобран, штатный вход восстановлен, возраст событий нормализован, заказы появились в базе. Проверены и позиции, и бизнес-результат.',
  },
  'poison-pill': {
    hypothesis: 'bad-record',
    fix: 'quarantine',
    initial: {
      metrics: metrics({ lag: 420, inRate: 90, outRate: 60 }),
      nodes: nodes({ consumer: 'blocked', external: 'degraded' }),
    },
    observations: {
      coordinate:
        'Все повторные ошибки имеют координату orders / partition 1 / offset 42. Партиции 0 и 2 читаются, соединение с Kafka не теряется.',
      contract:
        'В значении amount пришла строка «unknown», а reader ожидает целое число. Сохранён безопасный фрагмент диагностики без пользовательских секретов.',
      retries:
        'За 60 попыток содержимое записи не изменилось. Повтор не исправляет формат; после offset 42 остаются необработанные события.',
    },
    diagnosis:
      'Ошибка воспроизводится на одной координате и объясняется нарушением контракта. Бесконечный сетевой retry здесь бесполезен.',
    wrongHypotheses: {
      network:
        'Другие партиции читаются, а ошибка всегда относится к одному payload. Это не свидетельство недоступности всего кластера.',
      disk: 'В наблюдениях нет ошибки диска. Сбой десериализации связан с форматом конкретной записи.',
    },
    wrongFixes: {
      'retry-forever': {
        metrics: { lag: 510 },
        text: 'Повтор прочитал тот же некорректный payload. Партиция осталась заблокирована, backlog вырос; конечного результата нет.',
      },
      'skip-blindly': {
        metrics: { lag: 0, outRate: 90 },
        nodes: { consumer: 'degraded', external: 'degraded' },
        text: 'Позиция сдвинулась, но событие offset 42 нигде не сохранено для разбора. Низкий lag скрывает пропуск. Для исправления вернись к ещё доступной записи и сохрани её с причиной.',
      },
    },
    repaired: {
      metrics: { lag: 120, inRate: 90, outRate: 150 },
      nodes: nodes({ consumer: 'degraded' }),
    },
    repairText:
      'Запись 42 и её координаты надёжно сохранены в карантине вместе с причиной. Сохранение подтверждено до продвижения offset. В этом кейсе независимые заказы допускают продолжение; карантин требует отдельного разбора и повторного запуска.',
    final: metrics({ inRate: 90, outRate: 90 }),
    verifyText:
      'Партиция продвинулась, последующие заказы обработаны. Карантин содержит исходную запись 42 и причину, назначен разбор. Поток восстановлен; исправление самого ошибочного бизнес-события остаётся отдельной контролируемой задачей.',
  },
  'advertised-listeners': {
    hypothesis: 'advertised-address',
    fix: 'correct-listeners',
    initial: {
      metrics: metrics({ lag: 300, inRate: 0, outRate: 0 }),
      nodes: nodes({ producer: 'blocked', consumer: 'blocked', external: 'degraded' }),
    },
    observations: {
      bootstrap:
        'TCP-соединение с localhost:19092 устанавливается. Это подтверждает только начальную точку обнаружения, а не достижимость лидеров всех партиций.',
      metadata:
        'Ответ metadata содержит kafka-internal:9092. Такой адрес корректен внутри контейнерной сети, но клиент на ноутбуке не является её участником.',
      reachability:
        'Из сети ноутбука имя kafka-internal не разрешается. Из контейнерной сети адрес доступен. Проверка выполнена из той же сети, где работает проблемный клиент.',
    },
    diagnosis:
      'Клиент получает внутреннее имя и затем подключается по нему. Начальный bootstrap работает, но advertised.listeners описывает чужую сетевую область.',
    wrongHypotheses: {
      credentials:
        'Ошибка наблюдается на разрешении адреса до проверки учётных данных. Смена пароля не сделает внутреннее имя достижимым.',
      replication:
        'Число партиций не меняет DNS и адреса брокеров. Сначала восстанови сетевую достижимость metadata endpoints.',
    },
    wrongFixes: {
      'zero-address': {
        text: '0.0.0.0 обозначает адрес привязки, а не достижимый адрес конкретного сервера; Kafka не допускает его как advertised.listeners. Клиент остаётся без рабочего endpoint.',
      },
      timeout: {
        text: 'Долгое ожидание не исправило DNS и маршрут. Ошибка теперь проявляется медленнее, а поток по-прежнему заблокирован.',
      },
    },
    repaired: {
      metrics: { lag: 300, inRate: 200, outRate: 400 },
      nodes: nodes({ consumer: 'degraded' }),
    },
    repairText:
      'Внутренний listener объявляет контейнерное имя, внешний - достижимый адрес хоста. Конфигурация применена управляемым перезапуском. Нужно проверить metadata и publish/consume именно из проблемной сети.',
    final: metrics(),
    verifyText:
      'Из сети ноутбука metadata возвращает достижимый endpoint; тестовая запись подтверждена, прочитана и сопоставлена по ключу и значению. Проверка TCP дополнена проверкой протокола и результата.',
  },
  'insufficient-isr': {
    hypothesis: 'replica-outage',
    fix: 'restore-replicas',
    initial: {
      metrics: metrics({ lag: 80, inRate: 0, outRate: 0, isr: 1 }),
      nodes: nodes({ producer: 'blocked', broker: 'degraded', consumer: 'degraded' }),
    },
    observations: {
      topic:
        'У topic RF=3, minISR=2; ISR содержит только leader. Назначение трёх копий не доказывает, что три реплики сейчас синхронны.',
      producer:
        'Producer использует acks=all и получает NotEnoughReplicas. Он не может подтвердить запись с выбранным минимальным числом синхронных копий.',
      replicas:
        'Два follower временно недоступны после сетевого изменения. Потери дисков не наблюдаются; требуется восстановить сеть и дождаться догоняющей репликации.',
    },
    diagnosis:
      'Отказ записи соответствует настройке сохранности: ISR меньше minISR. Медленный commit consumer не определяет состав ISR.',
    wrongHypotheses: {
      'message-size':
        'Наблюдаемая ошибка сообщает о репликах, а не превышении размера записи. Подмена причины не восстановит ISR.',
      'consumer-speed':
        'Репликация между брокерами и обработка consumer являются разными процессами. Состав ISR не исправляется ускорением commit группы.',
    },
    wrongFixes: {
      'lower-min-isr': {
        metrics: { inRate: 200, outRate: 200, isr: 1 },
        text: 'Запись снова принимается при одной копии, но требование двух синхронных копий нарушено. Доступность не доказывает сохранность: решение не засчитывается.',
      },
      'disable-acks': {
        metrics: { inRate: 200, outRate: 0, isr: 1 },
        text: 'Producer перестал ждать подтверждение, поэтому отсутствие ошибки не доказывает запись. Реплики не восстановлены, исходная гарантия потеряна.',
      },
    },
    repaired: {
      metrics: { lag: 80, inRate: 200, outRate: 300, isr: 3 },
      nodes: nodes({ consumer: 'degraded' }),
    },
    repairText:
      'Сеть follower восстановлена, реплики догнали leader и вернулись в ISR. Исходные minISR=2 и acks=all восстановлены, если менялись. Проверь новую подтверждённую запись и состояние реплик.',
    final: metrics(),
    verifyText:
      'ISR=3 стабилен, контрольная запись с acks=all подтверждена и прочитана, backlog обработан. Это результат многоброкерной учебной модели, а не HA-тест локальной лаборатории одного брокера.',
  },
  'disk-full': {
    hypothesis: 'storage',
    fix: 'expand-capacity',
    initial: {
      metrics: metrics({ lag: 500, inRate: 0, outRate: 50, disk: 99 }),
      nodes: nodes({ producer: 'blocked', broker: 'blocked', consumer: 'degraded' }),
    },
    observations: {
      filesystem:
        'Файловая система log.dirs занята на 99%, свободного места недостаточно для следующей записи. В журнале broker ошибка No space left on device.',
      retention:
        'Основное место занимают сегменты topic с согласованной историей 7 дней. Логи приложения малы; удаление «случайных файлов» не является безопасным планом.',
      growth:
        'Входящий объём удвоился, ёмкость не пересчитывали. Необходим запас на рост и перераспределение, а не только на текущий размер.',
    },
    diagnosis:
      'Подтверждены исчерпание диска и рост хранения. Проблема требует управления ёмкостью с сохранением требуемой истории.',
    wrongHypotheses: {
      'poll-timeout':
        'max.poll.interval.ms относится к consumer. Он не создаёт свободное место на диске broker.',
      key: 'Kafka допускает разные форматы ключей. Тип ключа не объясняет уже измеренную заполненность файловой системы.',
    },
    wrongFixes: {
      'delete-segments': {
        metrics: { disk: 45, inRate: 0, outRate: 0 },
        nodes: {
          producer: 'blocked',
          broker: 'blocked',
          consumer: 'blocked',
          external: 'degraded',
        },
        recoveryRequired: true,
        text: 'Свободное место появилось, но ручное удаление повредило учебный журнал. Расширение диска не восстановит удалённые записи. В реальности нужен план восстановления из здоровой реплики или копии; здесь нажми «Начать заново», чтобы проверить безопасный путь.',
      },
      'retention-zero': {
        metrics: { disk: 52, inRate: 200, outRate: 100 },
        recoveryRequired: true,
        text: 'Место освободилось за счёт удаления требуемой истории. Доступность восстановилась ценой нарушения контракта хранения. Вернуть retention недостаточно, чтобы вернуть данные; для продолжения учебного кейса начни заново.',
      },
    },
    repaired: {
      metrics: { lag: 500, inRate: 100, outRate: 300, disk: 62 },
      nodes: nodes({ consumer: 'degraded' }),
    },
    repairText:
      'Вход ограничен, ёмкость увеличена и данные перенесены штатным механизмом с контролем репликации. История сохранена, заполненность 62%. Требуется проверить чтение старых и запись новых данных.',
    final: metrics({ disk: 63 }),
    verifyText:
      'Контрольные старые записи доступны, новая запись подтверждена и прочитана, реплики синхронны, заполненность остаётся ниже порога. Штатный вход восстановлен, прогноз ёмкости обновлён.',
  },
  'duplicate-charge': {
    hypothesis: 'split-commit',
    fix: 'idempotent-reconcile',
    initial: {
      metrics: metrics({ lag: 0, inRate: 60, outRate: 60, duplicates: 3 }),
      nodes: nodes({ consumer: 'degraded', external: 'blocked' }),
    },
    observations: {
      ledger:
        'В платёжном реестре для трёх eventId есть по два успешных списания. Lag равен нулю, но бизнес-результат неверен.',
      commits:
        'Сначала платёжный сервис вернул успех, затем consumer упал до commit. После запуска он повторно получил те же записи из прежней позиции.',
      'payment-api':
        'Получатель поддерживает устойчивый idempotency key и запрос статуса операции. Текущий обработчик каждый раз генерирует новый ключ, поэтому повтор считается новым платежом.',
    },
    diagnosis:
      'Повтор произошёл в окне между внешним результатом и commit Kafka. Требуется идемпотентность получателя и отдельная сверка уже выполненных списаний.',
    wrongHypotheses: {
      'producer-only':
        'Producer idempotence относится к отправке в Kafka. Здесь повторно выполняется внешний HTTP-платёж после чтения существующей записи.',
      'replication-factor':
        'Дополнительная копия журнала не связывает внешний платёж с offset. Причина находится в границе бизнес-транзакции.',
    },
    wrongFixes: {
      'producer-idempotence': {
        metrics: { duplicates: 4 },
        text: 'Producer изменён, но повторный вызов consumer снова создал внешний платёж. Несогласованных дубликатов стало 4; граница проблемы не исправлена.',
      },
      'commit-first': {
        metrics: { lag: 0, outRate: 60 },
        text: 'Ранний commit скрывает будущую повторную доставку ценой возможного пропуска платежа при сбое. Существующие дубли не исправлены, бизнес-результат не подтверждён.',
      },
    },
    repaired: {
      metrics: { lag: 0, inRate: 60, outRate: 60 },
      nodes: nodes({ external: 'degraded' }),
    },
    repairText:
      'Обработчик передаёт устойчивый idempotency key из eventId, проверяет неоднозначный результат и коммитит после подтверждения. Подготовлена сверка и компенсация прежних дублей; они не исчезают от изменения кода.',
    final: metrics({ inRate: 60, outRate: 60, duplicates: 0 }),
    verifyText:
      'Повтор того же eventId не создал нового списания. Сверка выполнила предусмотренные компенсации: неурегулированных дублей 0, история прошлых операций сохранена. Проверен бизнес-реестр, а не только lag.',
  },
};

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_INCIDENT_INPUT';
  return error;
}

function definition(id) {
  const incident = incidents.find((item) => item.id === id);
  if (!incident || !Object.hasOwn(models, id)) throw invalid('Неизвестный учебный инцидент.');
  return { incident, model: models[id] };
}

function updateFlow(state) {
  const statuses = Object.values(state.nodes);
  state.flow = statuses.includes('blocked')
    ? 'blocked'
    : statuses.includes('degraded')
      ? 'degraded'
      : 'healthy';
}

function record(state, text, kind = 'info') {
  updateFlow(state);
  state.history.push({
    text,
    kind,
    phase: state.phase,
    metrics: { ...state.metrics },
    nodes: { ...state.nodes },
  });
  if (state.history.length > 40) state.history = [state.history[0], ...state.history.slice(-39)];
  return state;
}

function patch(state, change) {
  Object.assign(state.metrics, change.metrics ?? {});
  Object.assign(state.nodes, change.nodes ?? {});
  if (change.recoveryRequired) state.recoveryRequired = true;
}

export function publicIncident(id) {
  return structuredClone(definition(id).incident);
}

export function createIncidentState(id) {
  const { incident, model } = definition(id);
  const state = {
    id,
    observed: [],
    hypothesis: null,
    fix: null,
    fixed: false,
    verified: false,
    attempts: 0,
    recoveryRequired: false,
    phase: 'observe',
    flow: 'degraded',
    history: [],
    metrics: { ...model.initial.metrics },
    nodes: { ...model.initial.nodes },
  };
  return record(state, `Учебная модель. ${incident.symptom} Собери минимум два разных наблюдения.`);
}

function validateState(id, state, incident) {
  if (
    !state ||
    state.id !== id ||
    !Array.isArray(state.observed) ||
    !Array.isArray(state.history) ||
    !state.metrics ||
    !state.nodes ||
    !Number.isSafeInteger(state.attempts) ||
    state.attempts < 0
  ) {
    throw invalid('Состояние инцидента повреждено. Начни сценарий заново.');
  }
  const observationIds = new Set(incident.observations.map((item) => item.id));
  if (
    state.observed.length > observationIds.size ||
    new Set(state.observed).size !== state.observed.length ||
    state.observed.some((value) => !observationIds.has(value)) ||
    Object.keys(healthyNodes).some(
      (key) => !['healthy', 'degraded', 'blocked'].includes(state.nodes[key]),
    ) ||
    Object.keys(metrics()).some(
      (key) => !Number.isFinite(state.metrics[key]) || state.metrics[key] < 0,
    )
  ) {
    throw invalid('Состояние инцидента не соответствует учебной модели.');
  }
}

export function actIncident(id, previousState, input) {
  const { incident, model } = definition(id);
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !['action', 'choice'].includes(key)) ||
    !['observe', 'hypothesis', 'fix', 'verify', 'reset'].includes(input.action)
  ) {
    throw invalid('Недопустимое действие инцидента.');
  }
  const { action, choice } = input;
  const list =
    action === 'observe'
      ? incident.observations
      : action === 'hypothesis'
        ? incident.hypotheses
        : action === 'fix'
          ? incident.fixes
          : null;
  if (list && (typeof choice !== 'string' || !list.some((item) => item.id === choice)))
    throw invalid('Выбери один из предложенных вариантов.');
  if (!list && choice !== undefined && choice !== null)
    throw invalid('Для этого действия вариант не требуется.');
  if (action === 'reset') return createIncidentState(id);
  validateState(id, previousState, incident);
  const state = structuredClone(previousState);
  state.attempts = Math.min(state.attempts + 1, 1_000_000);

  if (state.verified)
    return record(
      state,
      'Инцидент уже проверен. Можно изучить историю или начать сценарий заново.',
      'info',
    );
  if (state.recoveryRequired)
    return record(
      state,
      'Выбранное действие привело к потере учебной истории. Обычная настройка не возвращает удалённые данные. Начни сценарий заново; в реальной системе потребовалась бы отдельная процедура восстановления.',
      'error',
    );

  if (action === 'observe') {
    if (state.observed.includes(choice))
      return record(
        state,
        'Это наблюдение уже собрано. Для проверки гипотезы нужны разные свидетельства.',
        'warning',
      );
    state.observed.push(choice);
    if (state.phase === 'observe' && state.observed.length >= 2) state.phase = 'hypothesis';
    return record(state, model.observations[choice]);
  }

  if (state.observed.length < 2)
    return record(
      state,
      'Пока недостаточно свидетельств. Собери минимум два разных наблюдения, прежде чем выбирать причину или менять систему.',
      'warning',
    );

  if (action === 'hypothesis') {
    state.hypothesis = choice;
    state.fix = null;
    state.fixed = false;
    if (choice !== model.hypothesis) {
      state.phase = 'hypothesis';
      return record(state, model.wrongHypotheses[choice], 'error');
    }
    state.phase = 'fix';
    return record(state, model.diagnosis, 'success');
  }

  if (state.hypothesis !== model.hypothesis)
    return record(
      state,
      'Причина пока не подтверждена. Выбери гипотезу, которая объясняет наблюдения; исправление без диагноза не засчитывается.',
      'warning',
    );

  if (action === 'fix') {
    state.fix = choice;
    state.fixed = choice === model.fix;
    if (!state.fixed) {
      const consequence = model.wrongFixes[choice];
      patch(state, consequence);
      state.phase = 'fix';
      return record(state, consequence.text, 'error');
    }
    patch(state, model.repaired);
    state.phase = 'verify';
    return record(state, model.repairText, 'success');
  }

  if (!state.fixed || state.fix !== model.fix)
    return record(
      state,
      'Проверка не подтвердила устранение причины. Нужен подходящий шаг исправления; зелёный график или нулевой lag сами по себе недостаточны.',
      'warning',
    );
  state.verified = true;
  state.phase = 'complete';
  state.metrics = { ...model.final };
  state.nodes = { ...healthyNodes };
  return record(state, model.verifyText, 'success');
}
