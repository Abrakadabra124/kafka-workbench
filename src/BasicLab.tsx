import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, FlaskConical, LoaderCircle, RefreshCw, Terminal } from 'lucide-react';
import { api } from './api';
import { LearningPath } from './LearningPath';

type LabState = { available: boolean; running: boolean; status: string };
const steps = [
  {
    action: 'start',
    title: 'Запустить брокер',
    description:
      'Отдельный контейнер Apache Kafka 4.2.2 в режиме KRaft. Готовность проверяется запросом к брокеру.',
    command: 'docker compose up -d --wait',
  },
  {
    action: 'topic',
    title: 'Создать топик orders',
    description: 'Три партиции, одна реплика. Проверка читает фактическое описание топика.',
    command: 'kafka-topics.sh --create --topic orders --partitions 3',
  },
  {
    action: 'produce',
    title: 'Записать три события',
    description:
      'Три заказа с ключами customer-42 и customer-7. Проверка сравнивает log end offsets до и после.',
    command: 'kafka-console-producer.sh --topic orders',
  },
  {
    action: 'consume',
    title: 'Прочитать события',
    description:
      'Группа workbench читает до трёх записей. Проверяем ключи и содержимое полученных заказов.',
    command: 'kafka-console-consumer.sh --group workbench --topic orders',
  },
  {
    action: 'inspect',
    title: 'Проверить состояние',
    description:
      'Посмотрите реальные партиции, сохранённые offsets и lag. Повторная запись добавляет новые события.',
    command: 'kafka-consumer-groups.sh --describe --group workbench',
  },
];
export function BasicLab() {
  return (
    <>
      <h1>Настоящая лаборатория</h1>
      <LearningPath id="basic-lab">
        <BasicLabPractice />
      </LearningPath>
    </>
  );
}
function BasicLabPractice() {
  const [savedJournal] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('kafka-basic-lab-journal-v1') ?? 'null');
      if (
        saved &&
        Array.isArray(saved.completed) &&
        saved.completed.length <= 5 &&
        saved.completed.every((action: unknown) => steps.some((step) => step.action === action)) &&
        typeof saved.output === 'string' &&
        saved.output.length <= 200000 &&
        typeof saved.updatedAt === 'string' &&
        !Number.isNaN(Date.parse(saved.updatedAt))
      )
        return saved as { completed: string[]; output: string; updatedAt: string };
    } catch {
      /* An unavailable or invalid browser journal leaves a fresh usable lab. */
    }
    return null;
  });
  const outputRef = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<LabState | null>(null);
  const [busy, setBusy] = useState('');
  const [output, setOutput] = useState(
    savedJournal?.output ?? 'Здесь появится фактический вывод Kafka и результат проверки.',
  );
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState<string[]>(savedJournal?.completed ?? []);
  const [journalDate, setJournalDate] = useState(savedJournal?.updatedAt ?? '');
  const [storageWarning, setStorageWarning] = useState('');
  const [confirm, setConfirm] = useState(false);
  async function refresh() {
    try {
      setStatus(await api<LabState>('lab'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  const externalBusy = status?.status.startsWith('Выполняется:');
  useEffect(() => {
    if (!externalBusy) return;
    const id = setInterval(() => void refresh(), 5000);
    return () => clearInterval(id);
  }, [externalBusy]);
  async function run(action: string) {
    setBusy(action);
    setError('');
    setConfirm(false);
    setOutput(
      action === 'start'
        ? 'Запускаем Kafka. Первая загрузка образа может занять несколько минут…'
        : 'Выполняется команда и проверка фактического состояния…',
    );
    try {
      const response = await fetch('/api/lab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const result = await response.json();
      const resultOutput = result.output ?? result.error ?? 'Сервер не вернул результат.';
      setOutput(resultOutput);
      const nextCompleted =
        response.ok && result.ok
          ? action === 'stop'
            ? []
            : [...new Set([...completed, action])]
          : completed;
      setCompleted(nextCompleted);
      const updatedAt = new Date().toISOString();
      setJournalDate(updatedAt);
      try {
        localStorage.setItem(
          'kafka-basic-lab-journal-v1',
          JSON.stringify({
            completed: nextCompleted,
            output: String(resultOutput).slice(-200000),
            updatedAt,
          }),
        );
      } catch {
        setStorageWarning(
          'Браузер не разрешил сохранить журнал. Скопируйте важный вывод перед закрытием страницы.',
        );
      }
      if (!response.ok || !result.ok)
        setError('Операция не подтверждена. Подробности в выводе ниже.');
      setStatus(await api<LabState>('lab'));
    } catch (e) {
      setError((e as Error).message);
      setOutput(
        'Не удалось получить результат. Команда могла продолжить работу. Обновите состояние перед повтором.',
      );
    } finally {
      setBusy('');
    }
  }
  const disabled = !!busy || !!externalBusy;
  return (
    <>
      <div className="page-heading with-action">
        <div>
          <h2>Практика на одном брокере</h2>
          <p>
            Тот же путь события, теперь на реальном Apache Kafka. Брокер работает в вашем Docker.
          </p>
        </div>
        <button className="outline" onClick={refresh} disabled={disabled}>
          <RefreshCw size={17} />
          Обновить
        </button>
      </div>
      {journalDate && (
        <p className="note">
          Журнал последней попытки: {new Date(journalDate).toLocaleString('ru-RU')}. Отметки шагов
          относятся к сохранённой попытке. Проверяйте текущую доступность кнопкой «Обновить», а
          данные - действием «Проверить состояние».
        </p>
      )}
      {storageWarning && <p role="status">{storageWarning}</p>}
      <div className="lab-status">
        <FlaskConical size={24} />
        <div>
          <strong>
            {!status
              ? 'Проверяем Docker…'
              : !status.available
                ? 'Docker недоступен'
                : status.status === 'ready'
                  ? 'Брокер готов'
                  : status.running
                    ? 'Брокер запущен'
                    : 'Лаборатория остановлена'}
          </strong>
          <span>
            {status?.status === 'ready'
              ? 'Apache Kafka 4.2.2 / KRaft / 1 broker'
              : status?.status === 'stopped'
                ? 'Запустите брокер первым шагом ниже.'
                : status?.status}
          </span>
        </div>
        <span className={`status-dot ${status?.status === 'ready' ? 'online' : ''}`} />
      </div>
      {!status?.available && status && (
        <div className="note">
          <strong>Для практики нужен Docker Engine</strong>
          <p>
            Запустите Docker Desktop с Linux containers и нажмите «Обновить». Уроки и песочница
            доступны без Docker.
          </p>
          <a
            href="https://docs.docker.com/get-started/get-docker/"
            target="_blank"
            rel="noreferrer"
          >
            Инструкция Docker
          </a>
        </div>
      )}
      <div className="lab-grid">
        <div className="lab-steps">
          {steps.map((step, i) => (
            <section
              className={`lab-step ${completed.includes(step.action) ? 'complete' : ''}`}
              key={step.action}
            >
              <div className="step-number">
                {completed.includes(step.action) ? (
                  <Check size={18} />
                ) : (
                  String(i + 1).padStart(2, '0')
                )}
              </div>
              <div>
                <h2>{step.title}</h2>
                <p>{step.description}</p>
                <code>{step.command}</code>
                <button
                  className={step.action === 'start' ? 'primary' : 'outline'}
                  disabled={
                    disabled || !status?.available || (step.action !== 'start' && !status.running)
                  }
                  onClick={() => run(step.action)}
                >
                  {busy === step.action ? (
                    <LoaderCircle className="spinning" size={17} />
                  ) : (
                    <ChevronRight size={17} />
                  )}
                  {busy === step.action ? 'Выполняется…' : step.title}
                </button>
                <button className="text lab-output-jump" onClick={() => outputRef.current?.focus()}>
                  Посмотреть вывод
                </button>
              </div>
            </section>
          ))}
        </div>
        <aside
          className="lab-terminal"
          ref={outputRef}
          tabIndex={-1}
          aria-label="Вывод и доказательства"
        >
          <div>
            <Terminal size={18} />
            <strong>Вывод и доказательства</strong>
            {busy && <LoaderCircle className="spinning" size={17} />}
          </div>
          <pre aria-live="polite" aria-busy={!!busy}>
            {output}
          </pre>
          {error && <p role="alert">{error}</p>}
        </aside>
      </div>
      <div className="note">
        <strong>Что доказывает эта лаборатория</strong>
        <p>
          Реальные metadata, запись и чтение из Kafka. Один брокер не даёт отказоустойчивости. Три
          партиции не означают три реплики. Команды показаны сокращённо; приложение передаёт полные
          фиксированные аргументы без shell.
        </p>
        <p>
          Первый запуск загружает образ из Docker Hub. Остановка удаляет только контейнеры и данные
          этой учебной лаборатории. Прогресс уроков остаётся.
        </p>
      </div>
      <div className="lab-cleanup">
        {confirm ? (
          <div className="button-row">
            <strong>Удалить контейнер и все учебные события?</strong>
            <button className="danger" disabled={disabled} onClick={() => run('stop')}>
              Удалить лабораторию
            </button>
            <button className="outline" onClick={() => setConfirm(false)}>
              Отмена
            </button>
          </div>
        ) : (
          <button
            className="outline danger"
            disabled={disabled || !status?.available}
            onClick={() => setConfirm(true)}
          >
            Остановить и удалить лабораторию
          </button>
        )}
      </div>
    </>
  );
}
