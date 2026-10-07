const apache = 'https://kafka.apache.org/42';
const option = (id, label) => ({ id, label });
const source = (title, url) => ({ title, url });

// Public catalogue only. Diagnostic findings and grading rules live on the server.
export const incidents = [
  {
    id: 'lag-growth',
    title: 'Lag растёт каждую минуту',
    summary: 'Заказы приходят быстрее, чем обработчик записывает их в базу.',
    symptom:
      'Вход 200 событий/с, обработка 80 событий/с, lag 1200. Подтверждения producer стабильны.',
    impact:
      'Склад видит заказы с задержкой. Добавление нагрузки способно перегрузить внешнюю базу ещё сильнее.',
    observations: [
      option('rates', 'Сравнить вход, обработку и lag'),
      option('database', 'Измерить задержку и нагрузку базы'),
      option('assignment', 'Проверить назначение партиций'),
    ],
    hypotheses: [
      option('consumer-count', 'Не хватает экземпляров consumer'),
      option('downstream', 'Внешняя база ограничивает обработку'),
      option('broker-loss', 'Брокер теряет все новые события'),
    ],
    fixes: [
      option('scale-consumers', 'Увеличить число consumer в 4 раза'),
      option('reset-latest', 'Перевести offset в конец журнала'),
      option(
        'repair-downstream',
        'Ограничить вход, исправить запрос к базе и восстановить обработку доступного backlog',
      ),
    ],
    sources: [
      source('Apache Kafka: Monitoring', `${apache}/operations/monitoring/`),
      source('Apache Kafka: Consumer Configs', `${apache}/configuration/consumer-configs/`),
    ],
  },
  {
    id: 'poison-pill',
    title: 'Одна запись остановила партицию',
    summary: 'Consumer снова и снова получает ошибку десериализации одного события.',
    symptom: 'Партиция 1 остановилась на offset 42. Другие партиции продолжают работу.',
    impact:
      'За повреждённой записью накапливаются заказы. Слепой пропуск скрывает необработанный бизнес-факт.',
    observations: [
      option('coordinate', 'Сравнить topic, partition и offset ошибок'),
      option('contract', 'Проверить payload и ожидаемую схему'),
      option('retries', 'Изучить историю повторов'),
    ],
    hypotheses: [
      option('network', 'Недоступны все брокеры'),
      option('bad-record', 'Конкретная запись нарушает контракт'),
      option('disk', 'Заполнен диск всех реплик'),
    ],
    fixes: [
      option('retry-forever', 'Повторять ту же запись без ограничения'),
      option(
        'quarantine',
        'Надёжно сохранить ошибочную запись и контекст в карантине, подтвердить сохранение и продолжить по принятой политике',
      ),
      option('skip-blindly', 'Молча пропустить событие'),
    ],
    sources: [
      source(
        'Confluent: Dead Letter Stream',
        'https://developer.confluent.io/patterns/event-processing/dead-letter-stream/',
      ),
      source(
        'Apache Kafka: KafkaConsumer API',
        `${apache}/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html`,
      ),
    ],
  },
  {
    id: 'advertised-listeners',
    title: 'Bootstrap доступен, Kafka недоступна',
    summary: 'Первое соединение устанавливается, затем клиент не может найти лидера партиции.',
    symptom: 'С ноутбука доступен localhost:19092, но metadata возвращает kafka-internal:9092.',
    impact:
      'Клиенты вне контейнерной сети не могут производить и читать события, хотя порт bootstrap открыт.',
    observations: [
      option('bootstrap', 'Проверить начальное соединение'),
      option('metadata', 'Посмотреть адреса брокеров в metadata'),
      option('reachability', 'Проверить DNS и соединение из сети клиента'),
    ],
    hypotheses: [
      option('advertised-address', 'Брокер сообщает клиенту недоступный адрес'),
      option('credentials', 'Всегда виноват неверный пароль'),
      option('replication', 'Не хватает партиций topic'),
    ],
    fixes: [
      option('zero-address', 'Рекламировать 0.0.0.0:9092'),
      option(
        'correct-listeners',
        'Настроить отдельные listener-адреса для сетей и объявлять клиентам достижимые host:port',
      ),
      option('timeout', 'Увеличить сетевой таймаут до часа'),
    ],
    sources: [
      source('Apache Kafka: Broker Configs', `${apache}/configuration/broker-configs/`),
      source('Apache Kafka: Listener Configuration', `${apache}/security/listener-configuration/`),
    ],
  },
  {
    id: 'insufficient-isr',
    title: 'Запись отклоняется из-за ISR',
    summary: 'Защита сохранности блокирует запись при недостатке синхронных копий.',
    symptom: 'RF=3, minISR=2, acks=all. В ISR один broker, producer получает NotEnoughReplicas.',
    impact:
      'Новые события не подтверждаются. Снижение требований создаёт риск потери при следующем отказе.',
    observations: [
      option('topic', 'Сопоставить RF, ISR и minISR'),
      option('producer', 'Проверить acks и ошибки producer'),
      option('replicas', 'Проверить доступность и состояние follower'),
    ],
    hypotheses: [
      option('message-size', 'Все сообщения слишком большие'),
      option('consumer-speed', 'Consumer слишком медленно коммитит'),
      option('replica-outage', 'Синхронных реплик меньше установленного минимума'),
    ],
    fixes: [
      option('restore-replicas', 'Восстановить follower и дождаться возвращения реплик в ISR'),
      option('lower-min-isr', 'Снизить minISR до 1 без изменения требований'),
      option('disable-acks', 'Поставить acks=0 и скрыть ошибки'),
    ],
    sources: [
      source('Apache Kafka: Topic Configs', `${apache}/configuration/topic-configs/`),
      source(
        'Confluent: Replication',
        'https://developer.confluent.io/courses/apache-kafka/replication/',
      ),
    ],
  },
  {
    id: 'disk-full',
    title: 'Диск брокера заполнен',
    summary: 'Объём поступающих событий превысил подготовленную ёмкость хранения.',
    symptom:
      'Диск 99%, запись останавливается с No space left on device. Сегменты topic занимают основное место.',
    impact:
      'Производители теряют возможность подтверждённой записи; ручное удаление файлов может повредить журнал.',
    observations: [
      option('filesystem', 'Проверить свободное место и ошибку записи'),
      option('retention', 'Посмотреть retention и распределение сегментов'),
      option('growth', 'Сравнить рост данных и план ёмкости'),
    ],
    hypotheses: [
      option('storage', 'Закончилась доступная ёмкость диска'),
      option('poll-timeout', 'Слишком мал max.poll.interval.ms'),
      option('key', 'Ключ события обязательно должен быть числом'),
    ],
    fixes: [
      option('delete-segments', 'Удалить файлы сегментов вручную из log.dirs'),
      option('retention-zero', 'Сократить retention до минимума без согласования'),
      option(
        'expand-capacity',
        'Ограничить вход, расширить ёмкость и безопасно перераспределить данные с проверкой истории',
      ),
    ],
    sources: [
      source('Apache Kafka: Hardware and OS', `${apache}/operations/hardware-and-os/`),
      source('Apache Kafka: Basic Operations', `${apache}/operations/basic-kafka-operations/`),
    ],
  },
  {
    id: 'duplicate-charge',
    title: 'После рестарта платёж повторился',
    summary: 'Платёж успешен, но процесс упал раньше сохранения offset.',
    symptom:
      'Для трёх eventId есть повторные списания. Kafka offset повторно прочитан после сбоя consumer.',
    impact:
      'Покупатели получили лишнее списание. Транспортная идемпотентность producer не исправляет внешнюю операцию.',
    observations: [
      option('ledger', 'Сопоставить eventId с платёжным реестром'),
      option('commits', 'Восстановить порядок платежа, сбоя и commit'),
      option('payment-api', 'Проверить поддержку idempotency key у получателя'),
    ],
    hypotheses: [
      option('producer-only', 'Достаточно включить producer idempotence'),
      option('split-commit', 'Внешний эффект и commit Kafka не атомарны'),
      option('replication-factor', 'Причина только в числе реплик topic'),
    ],
    fixes: [
      option(
        'idempotent-reconcile',
        'Добавить устойчивый ключ идемпотентности, проверить повтор и выполнить сверку с компенсацией лишних списаний',
      ),
      option('producer-idempotence', 'Изменить только enable.idempotence у producer'),
      option('commit-first', 'Коммитить offset до вызова платёжной системы'),
    ],
    sources: [
      source('Apache Kafka: Delivery Semantics', `${apache}/design/design/`),
      source(
        'Confluent: Transactions',
        'https://developer.confluent.io/courses/architecture/transactions/',
      ),
    ],
  },
];
