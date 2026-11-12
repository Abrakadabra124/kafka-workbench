import { useEffect, useState } from 'react';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import { api } from './api';
import { WorkspaceScene } from './WorkspaceScene';
import { PracticeWalkthrough } from './PracticeWalkthrough';
import type { RunEvent, WorkspaceData, WorkspaceState } from './workspace-types';
import './workspace.css';
const labels: Record<string, string> = {
  prepare: 'Подготовка',
  produce: 'Запись',
  consume: 'Чтение',
  inspect: 'Наблюдение',
  verify: 'Проверка',
  fault: 'Сбой',
  recover: 'Восстановление',
  stop: 'Удаление',
  unsafe: 'Проверка опасного решения',
  retry: 'Повтор без устранения причины',
  interrupt: 'Остановка перед commit',
};
export function Workspace({ initialTask }: { initialTask?: string }) {
  const [data, setData] = useState<WorkspaceData | null>(null);
  const [selected, setSelected] = useState(
    initialTask &&
      [
        'delivery',
        'replay',
        'recovery',
        'poison-quarantine',
        'isr-write-gate',
        'retention-gap',
      ].includes(initialTask)
      ? initialTask
      : 'delivery',
  );
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState('');
  const [frame, setFrame] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [eligible, setEligible] = useState(false);
  const state = data?.states[selected];
  const task = data?.tasks.find((t) => t.id === selected);
  const history = state?.history ?? [];
  const historical = frame !== null;
  const event = historical ? history[frame] : history.at(-1);
  const snapshot = historical ? (event?.snapshot ?? null) : (state?.snapshot ?? null);
  async function refresh() {
    try {
      setData(await api<WorkspaceData>('workspace'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!playing || !eligible || frame === null) return;
    const timer = setTimeout(() => {
      if (frame >= history.length - 1) setPlaying(false);
      else setFrame(frame + 1);
    }, 1800);
    return () => clearTimeout(timer);
  }, [playing, eligible, frame, history.length]);
  function update(next: WorkspaceState) {
    setData((old) => (old ? { ...old, states: { ...old.states, [selected]: next } } : old));
  }
  async function run(action: string) {
    if (!state) return;
    setBusy(action);
    setError('');
    setNotice('');
    setConfirm('');
    setFrame(null);
    setPlaying(false);
    try {
      const response = await fetch('/api/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: selected,
          action,
          draft: state.draft,
          ...(['prepare', 'stop'].includes(action) ? { confirm: 'RESET' } : {}),
        }),
      });
      const result = (await response.json()) as {
        ok: boolean;
        state?: WorkspaceState;
        event?: RunEvent;
        error?: string;
      };
      if (result.state) update(result.state);
      if (!response.ok || !result.ok) setError(result.error ?? 'Операция не подтверждена.');
      else
        setNotice(
          action === 'save' ? 'Рецепт сохранён.' : (result.event?.message ?? 'Операция завершена.'),
        );
      if (action === 'stop') await refresh();
    } catch {
      setError(
        'Ответ не получен. Операция могла продолжиться на сервере. Обновите состояние перед повтором.',
      );
    } finally {
      setBusy('');
    }
  }
  const disabled = !!busy || !!data?.busy;
  const canOperate = !!state?.prepared && !!data?.available && !disabled && !historical;
  return (
    <>
      <div className="page-heading with-action">
        <div>
          <span className="eyebrow">KAFKA / ИНЖЕНЕРНАЯ ПРАКТИКА</span>
          <h1>Рабочее место лаборатории</h1>
          <p>Изменяйте решение. Наблюдайте систему. Доказывайте восстановление.</p>
        </div>
        <button className="outline" onClick={refresh} disabled={!!busy}>
          <RefreshCw size={16} />
          Обновить состояние
        </button>
      </div>
      {error && (
        <div role="alert" className="workspace-error">
          <TriangleAlert size={18} />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <p role="status" className="workspace-notice">
          {notice}
        </p>
      )}
      {!data ? (
        <p role="status">Проверяем доступность стенда…</p>
      ) : (
        <>
          <div className="workspace-task-row">
            {data.tasks.map((t, i) => (
              <button
                key={t.id}
                className={`workspace-task ${selected === t.id ? 'selected' : ''}`}
                aria-pressed={selected === t.id}
                disabled={disabled}
                onClick={() => {
                  setSelected(t.id);
                  setFrame(null);
                  setPlaying(false);
                  setConfirm('');
                  setError('');
                  setNotice('');
                }}
              >
                <span>0{i + 1}</span>
                <strong>{t.title}</strong>
                <ChevronRight size={16} />
              </button>
            ))}
          </div>
          {!data.available && (
            <div className="note">
              <strong>Для практики нужен Docker Engine</strong>
              <p>
                Запустите Docker Desktop с Linux containers и обновите состояние. Рецепты и история
                доступны без Docker.
              </p>
            </div>
          )}
          {state && task && (
            <>
              <div className="workspace-brief">
                <div>
                  <h2>{task.title}</h2>
                  <p>{task.description}</p>
                </div>
                <span className={`workspace-result ${state.verified ? 'is-passed' : ''}`}>
                  {state.verified ? (
                    <>
                      <ShieldCheck size={18} />
                      Результат проверен
                    </>
                  ) : (
                    <>
                      Попытка {state.attempt} ·{' '}
                      {state.prepared ? 'стенд подготовлен' : 'нужна подготовка'}
                    </>
                  )}
                </span>
              </div>
              <WorkspaceScene
                snapshot={snapshot}
                replaying={historical}
                playing={playing}
                eventId={event?.id}
                action={
                  event?.ok && (event.result.records?.length ?? 0) > 0 ? event.action : undefined
                }
                onPlaying={setPlaying}
                onEligible={setEligible}
              />
              <div className="workspace-history-controls">
                <div>
                  <strong>{historical ? 'Просмотр записи' : 'Текущий стенд'}</strong>
                  <span>
                    {historical
                      ? 'Действия недоступны до возврата к стенду.'
                      : 'Метрики обновляются после действий и инспекции.'}
                  </span>
                </div>
                <div className="button-row">
                  <button
                    className="outline"
                    disabled={history.length < 1 || disabled}
                    onClick={() => {
                      setFrame(0);
                      setPlaying(eligible);
                    }}
                  >
                    <Play size={15} />
                    История по шагам
                  </button>
                  {frame !== null && (
                    <>
                      <button
                        className="outline"
                        aria-label="Предыдущий шаг"
                        disabled={frame === 0}
                        onClick={() => {
                          setPlaying(false);
                          setFrame(Math.max(0, frame - 1));
                        }}
                      >
                        <ChevronLeft size={16} />
                      </button>
                      <button
                        className="outline"
                        aria-label="Следующий шаг"
                        disabled={frame >= history.length - 1}
                        onClick={() => {
                          setPlaying(false);
                          setFrame(Math.min(history.length - 1, frame + 1));
                        }}
                      >
                        <ChevronRight size={16} />
                      </button>
                      <button
                        className="outline"
                        onClick={() => {
                          setFrame(null);
                          setPlaying(false);
                        }}
                      >
                        К текущему стенду
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="workspace-body">
                <section className="workspace-editor">
                  {task.practice ? (
                    <PracticeWalkthrough task={selected} key={selected} />
                  ) : (
                    <>
                      <div className="workspace-panel-title">
                        <h2>Ваше решение</h2>
                        <span>recipe.json</span>
                      </div>
                      <p>
                        Измените записи, partition и настройки consumer. Это конфигурация реального
                        запуска. Произвольный код не исполняется.
                      </p>
                      <label htmlFor="workspace-recipe">JSON-рецепт</label>
                      <textarea
                        id="workspace-recipe"
                        spellCheck={false}
                        value={state.draft}
                        disabled={disabled || historical}
                        onChange={(e) => update({ ...state, draft: e.target.value })}
                      />
                      <div className="button-row">
                        <button
                          className="outline"
                          disabled={disabled || historical}
                          onClick={() => run('save')}
                        >
                          <Save size={16} />
                          Сохранить рецепт
                        </button>
                        <details>
                          <summary>Формат и подсказка</summary>
                          <p>{task.hint}</p>
                          <p>
                            records: 1..12, partition: 0..2. group: orders или audit. maxRecords:
                            1..36. commit: true или false. Изменение рецепта не отправляет данные до
                            запуска.
                          </p>
                        </details>
                      </div>
                    </>
                  )}
                </section>
                <section className="workspace-runner">
                  <div className="workspace-panel-title">
                    <h2>Исполнение</h2>
                    <span>{busy ? (labels[busy] ?? 'Сохранение') : 'Явные действия'}</span>
                  </div>
                  <div className="workspace-run-actions">
                    <button
                      className="outline"
                      disabled={disabled || !data.available || historical}
                      onClick={() => setConfirm('prepare')}
                    >
                      1. Подготовить новую попытку
                    </button>
                    {!task.practice && (
                      <>
                        <button disabled={!canOperate} onClick={() => run('produce')}>
                          2. Записать из рецепта
                        </button>
                      </>
                    )}
                    <button disabled={!canOperate} onClick={() => run('consume')}>
                      3. Прочитать группой
                    </button>
                    <button
                      className="outline"
                      disabled={!canOperate}
                      onClick={() => run('inspect')}
                    >
                      Наблюдать состояние
                    </button>
                    {(selected === 'recovery' || task.practice) && (
                      <>
                        <button
                          className="outline danger"
                          disabled={!canOperate}
                          onClick={() => run('fault')}
                        >
                          {task.practice
                            ? '2. Воспроизвести и диагностировать сбой'
                            : 'Отключить broker 3'}
                        </button>
                        <button
                          className="outline"
                          disabled={!canOperate}
                          onClick={() => run('recover')}
                        >
                          {task.practice
                            ? '3. Применить обоснованное исправление'
                            : 'Восстановить broker 3'}
                        </button>
                      </>
                    )}
                    {task.practice && (
                      <>
                        <button
                          className="outline danger"
                          disabled={!canOperate}
                          onClick={() => run('unsafe')}
                        >
                          {selected === 'isr-write-gate'
                            ? 'Попробовать minISR=2'
                            : 'Попробовать commit в конец'}
                        </button>
                        <button
                          className="outline"
                          disabled={!canOperate}
                          onClick={() => run('retry')}
                        >
                          {selected === 'retention-gap'
                            ? 'Прочитать только доступный хвост'
                            : 'Повторить без ремонта'}
                        </button>
                        {selected === 'poison-quarantine' && (
                          <button
                            className="outline"
                            disabled={!canOperate}
                            onClick={() => run('interrupt')}
                          >
                            Прервать после карантина, до commit
                          </button>
                        )}
                      </>
                    )}
                    <button
                      className="primary"
                      disabled={!canOperate}
                      onClick={() => run('verify')}
                    >
                      <ShieldCheck size={18} />
                      Проверить результат
                    </button>
                  </div>
                  {busy && (
                    <p role="status">
                      {labels[busy] ?? 'Сохранение'} выполняется. Ожидаем подтверждение от сервера…
                    </p>
                  )}
                  {data.busy && (
                    <p role="status">
                      На сервере выполняется {labels[data.busy.action]}. Обновите состояние после
                      завершения.
                    </p>
                  )}
                  <div className="workspace-evidence">
                    {task.practice &&
                      event?.result &&
                      (event.result.evidence !== undefined || event.result.code) && (
                        <pre
                          className="practice-evidence"
                          aria-label="Фактическое доказательство Kafka"
                        >
                          {JSON.stringify(event.result.evidence ?? event.result, null, 2)}
                        </pre>
                      )}
                    <h3>
                      <Terminal size={16} />
                      Наблюдения и доказательства
                    </h3>
                    {event ? (
                      <>
                        <p>
                          {labels[event.action]} ·{' '}
                          {new Date(event.finishedAt).toLocaleTimeString('ru-RU')}
                        </p>
                        <p className={!event.ok ? 'evidence-error' : ''}>{event.message}</p>
                        {event.result.checks && (
                          <ul className="workspace-checks">
                            {event.result.checks.map((c) => (
                              <li key={c.label}>
                                {c.ok ? <Check size={16} /> : <TriangleAlert size={16} />}
                                <span>
                                  {c.label}:{' '}
                                  <strong>{c.ok ? 'подтверждено' : 'не подтверждено'}</strong>
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {event.result.records && (
                          <pre>
                            {event.result.records
                              .map(
                                (r) =>
                                  `p${r.partition} / offset ${r.offset} | ${r.key} | ${r.value}`,
                              )
                              .join('\n') || 'Новых записей нет.'}
                          </pre>
                        )}
                      </>
                    ) : (
                      <p>Здесь появятся реальные ответы Kafka. Запуск не равен зачёту.</p>
                    )}
                  </div>
                </section>
              </div>
              <div className="workspace-timeline">
                <h2>Журнал попыток</h2>
                <p>
                  Сохранены последние 48 операций. Снимки в истории являются записью, а не текущим
                  состоянием.
                </p>
                <ol>
                  {history.map((h, i) => (
                    <li key={h.id}>
                      <button
                        className="outline"
                        aria-pressed={frame === i}
                        onClick={() => {
                          setFrame(i);
                          setPlaying(false);
                        }}
                      >
                        <span>{String(i + 1).padStart(2, '0')}</span>
                        {labels[h.action]}
                        <small>
                          {!h.ok
                            ? 'ошибка'
                            : h.action === 'verify'
                              ? h.result.passed
                                ? 'зачтено'
                                : 'не зачтено'
                              : 'выполнено'}
                        </small>
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="note">
                <strong>Последствия решения</strong>
                <p>{task.consequence}</p>
                <p>
                  Три брокера работают на одном компьютере. Это настоящая репликация в учебном
                  стенде, но не доказательство устойчивости к отказу машины или production SLA.
                </p>
              </div>
              <div className="workspace-cleanup">
                {confirm ? (
                  <div role="group" aria-label="Подтверждение сброса">
                    <p>
                      {confirm === 'prepare'
                        ? 'Удалить topic и группы только выбранного задания и начать новую попытку?'
                        : 'Удалить все контейнеры и данные нового трёхброкерного стенда?'}{' '}
                      История, черновики и прогресс уроков сохранятся.
                    </p>
                    <div className="button-row">
                      <button className="danger" onClick={() => run(confirm)}>
                        Подтвердить сброс
                      </button>
                      <button className="outline" onClick={() => setConfirm('')}>
                        Отмена
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="outline danger"
                    disabled={disabled || !data.available || historical}
                    onClick={() => setConfirm('stop')}
                  >
                    Остановить новый стенд
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
