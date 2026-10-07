import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Database,
  Eye,
  Info,
  Pause,
  Play,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  SkipBack,
  SkipForward,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { api } from './api';
import './incidents.css';

type NodeStatus = 'healthy' | 'degraded' | 'blocked';
type Nodes = Record<'producer' | 'broker' | 'consumer' | 'external', NodeStatus>;
type Metrics = {
  lag: number;
  inRate: number;
  outRate: number;
  isr: number;
  disk: number;
  duplicates: number;
};
type Frame = {
  text: string;
  kind: 'info' | 'success' | 'warning' | 'error';
  metrics: Metrics;
  nodes: Nodes;
};
type IncidentState = {
  id: string;
  observed: string[];
  hypothesis: string | null;
  fixed: boolean;
  verified: boolean;
  attempts: number;
  recoveryRequired: boolean;
  history: Frame[];
  metrics: Metrics;
  nodes: Nodes;
  flow: NodeStatus;
  phase: 'observe' | 'hypothesis' | 'fix' | 'verify' | 'complete';
};
type Choice = { id: string; label: string };
type Incident = {
  id: string;
  title: string;
  summary: string;
  symptom: string;
  impact: string;
  observations: Choice[];
  hypotheses: Choice[];
  fixes: Choice[];
  sources: { title: string; url: string }[];
};
type Detail = { incident: Incident; state: IncidentState };
type Action = 'observe' | 'hypothesis' | 'fix' | 'verify' | 'reset';

const phaseLabels = {
  observe: 'Соберите наблюдения',
  hypothesis: 'Проверьте гипотезу',
  fix: 'Выберите исправление',
  verify: 'Проверьте результат',
  complete: 'Восстановление подтверждено',
};
const statusLabels: Record<NodeStatus, string> = {
  healthy: 'Работает',
  degraded: 'Есть проблема',
  blocked: 'Заблокирован',
};
const flowNodes = [
  { id: 'producer', title: 'Producer', subtitle: 'Запись событий', Icon: Send },
  { id: 'broker', title: 'Kafka broker', subtitle: 'Журнал и реплики', Icon: Database },
  { id: 'consumer', title: 'Consumer', subtitle: 'Обработка событий', Icon: Activity },
  {
    id: 'external',
    title: 'Внешняя система',
    subtitle: 'Результат для бизнеса',
    Icon: CheckCircle2,
  },
] as const;
const metricLabels: { id: keyof Metrics; label: string; unit: string }[] = [
  { id: 'inRate', label: 'Входящий поток', unit: 'событий/с' },
  { id: 'outRate', label: 'Обработка', unit: 'событий/с' },
  { id: 'lag', label: 'Отставание группы', unit: 'событий' },
  { id: 'isr', label: 'Синхронные реплики', unit: 'из 3' },
  { id: 'disk', label: 'Диск брокера', unit: '%' },
  { id: 'duplicates', label: 'Неурегулированные дубли', unit: 'операций' },
];
const number = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });

function FlowPlayback({ incident, state }: Detail) {
  const [frameIndex, setFrameIndex] = useState(state.history.length - 1);
  const [playing, setPlaying] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const history = state.history.length
    ? state.history
    : [
        {
          text: incident.symptom,
          kind: 'info' as const,
          metrics: state.metrics,
          nodes: state.nodes,
        },
      ];
  const index = Math.min(Math.max(frameIndex, 0), history.length - 1);
  const frame = history[index];
  const baseline = history[0].metrics;
  const lastHistory = useRef(state.history);

  useEffect(() => {
    if (lastHistory.current !== state.history) {
      setFrameIndex(Math.max(0, state.history.length - 1));
      setPlaying(false);
      lastHistory.current = state.history;
    }
  }, [state.history]);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      setReducedMotion(media.matches);
      setPlaying(false);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!playing || history.length < 2) return;
    const timer = window.setTimeout(() => {
      if (index >= history.length - 1) setPlaying(false);
      else setFrameIndex(index + 1);
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [playing, history.length, index]);

  function showFrame(next: number) {
    setPlaying(false);
    setFrameIndex(next);
  }
  function togglePlayback() {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (index === history.length - 1 && history.length > 1) setFrameIndex(0);
    setPlaying(true);
  }
  return (
    <section className="inc-playback" aria-labelledby="inc-flow-heading">
      <div className="inc-section-title">
        <div>
          <span className="inc-eyebrow">Причина и последствия</span>
          <h3 id="inc-flow-heading">Путь события</h3>
        </div>
        <span className="inc-model-label">
          <Info size={14} />
          Учебная модель
        </span>
      </div>
      <div
        className={`inc-flow ${playing && !reducedMotion ? 'inc-playing' : ''}`}
        aria-label="Состояние компонентов в выбранном кадре"
      >
        {flowNodes.map((node, nodeIndex) => {
          const status = frame.nodes[node.id];
          const nextStatus = nodeIndex < 3 ? frame.nodes[flowNodes[nodeIndex + 1].id] : status;
          const edgeStatus =
            status === 'blocked' || nextStatus === 'blocked'
              ? 'blocked'
              : status === 'degraded' || nextStatus === 'degraded'
                ? 'degraded'
                : 'healthy';
          return (
            <div className="inc-flow-part" key={node.id}>
              <div className={`inc-node inc-node-${status}`}>
                <node.Icon size={23} strokeWidth={1.7} />
                <strong>{node.title}</strong>
                <span>{node.subtitle}</span>
                <small className="inc-node-status">
                  {status === 'healthy' ? <Check size={12} /> : <TriangleAlert size={12} />}
                  {statusLabels[status]}
                </small>
                {node.id === 'broker' && (
                  <div
                    className="inc-replicas"
                    aria-label={`${frame.metrics.isr} из 3 реплик в ISR`}
                  >
                    {[1, 2, 3].map((replica) => (
                      <i
                        key={replica}
                        className={replica <= frame.metrics.isr ? 'is-in-sync' : ''}
                      />
                    ))}
                    <span>ISR {frame.metrics.isr}/3</span>
                  </div>
                )}
              </div>
              {nodeIndex < 3 && (
                <div
                  className={`inc-link inc-link-${edgeStatus} ${node.id === 'consumer' && frame.metrics.duplicates > 0 ? 'inc-link-duplicates' : ''}`}
                  aria-hidden="true"
                >
                  <span className="inc-link-track" />
                  <i className="inc-pulse" />
                  <i className="inc-pulse inc-pulse-second" />
                  <ArrowRight size={16} />
                  <span className="inc-link-caption">
                    {edgeStatus === 'blocked'
                      ? 'сбой'
                      : edgeStatus === 'degraded'
                        ? 'задержка'
                        : 'поток'}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <dl className="inc-metrics">
        {metricLabels.map((metric) => (
          <div key={metric.id}>
            <dt>{metric.label}</dt>
            <dd>
              {number.format(frame.metrics[metric.id])}
              <span>{metric.unit}</span>
              <small>
                {frame.metrics[metric.id] === baseline[metric.id]
                  ? 'Исходное значение'
                  : `В начале: ${number.format(baseline[metric.id])}`}
              </small>
            </dd>
          </div>
        ))}
      </dl>
      <div className="inc-playback-controls">
        <div className="inc-player-buttons">
          <button
            className="outline"
            onClick={() => showFrame(index - 1)}
            disabled={index === 0}
            aria-label="Предыдущий кадр"
          >
            <SkipBack size={16} />
          </button>
          <button
            className="outline inc-play-button"
            onClick={togglePlayback}
            aria-pressed={playing}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
            {playing ? 'Пауза' : 'Воспроизвести'}
          </button>
          <button
            className="outline"
            onClick={() => showFrame(index + 1)}
            disabled={index === history.length - 1}
            aria-label="Следующий кадр"
          >
            <SkipForward size={16} />
          </button>
        </div>
        <span className="inc-frame-count">
          Кадр {index + 1} из {history.length}
        </span>
      </div>
      <p className={`inc-frame-explanation inc-frame-${frame.kind}`}>
        <span>Что происходит</span>
        {frame.text}
      </p>
      {reducedMotion && (
        <p className="inc-motion-note">
          В системе включено уменьшение движения. История доступна по кадрам без движущихся
          маркеров.
        </p>
      )}
      {index < history.length - 1 && (
        <p className="inc-history-notice">
          <Info size={14} />
          Показан прошлый кадр. Решения ниже относятся к текущему состоянию.
          <button className="text" onClick={() => showFrame(history.length - 1)}>
            К текущему состоянию
          </button>
        </p>
      )}
      <details className="inc-history">
        <summary>
          История расследования <span>{history.length}</span>
        </summary>
        <ol>
          {history.map((entry, entryIndex) => (
            <li key={`${entryIndex}-${entry.text}`}>
              <button
                className={entryIndex === index ? 'inc-history-active' : ''}
                onClick={() => showFrame(entryIndex)}
                aria-current={entryIndex === index ? 'step' : undefined}
              >
                <span className={`inc-history-dot inc-history-${entry.kind}`}>
                  {entryIndex + 1}
                </span>
                <span>{entry.text}</span>
                <Eye size={15} />
              </button>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}

function Investigation({
  incident,
  state,
  busy,
  act,
}: Detail & { busy: boolean; act: (action: Action, choice?: string) => void }) {
  const [resetConfirm, setResetConfirm] = useState(false);
  const steps = [
    { phase: 'observe', title: 'Наблюдения', Icon: Search, done: state.observed.length >= 2 },
    {
      phase: 'hypothesis',
      title: 'Гипотеза',
      Icon: Eye,
      done: ['fix', 'verify', 'complete'].includes(state.phase),
    },
    { phase: 'fix', title: 'Исправление', Icon: Wrench, done: state.fixed },
    { phase: 'verify', title: 'Проверка', Icon: ShieldCheck, done: state.verified },
  ];
  const panel =
    state.phase === 'observe'
      ? {
          choices: incident.observations,
          action: 'observe' as const,
          help: 'Соберите минимум два разных наблюдения. Сначала факты, затем изменение системы.',
        }
      : state.phase === 'hypothesis'
        ? {
            choices: incident.hypotheses,
            action: 'hypothesis' as const,
            help: 'Выберите причину, которую подтверждают собранные факты. Ошибочный вывод даст обратную связь.',
          }
        : state.phase === 'fix'
          ? {
              choices: incident.fixes,
              action: 'fix' as const,
              help: 'Исправьте причину. Быстрое изменение может убрать симптом, сохранив риск потери данных.',
            }
          : null;
  const latest = state.history.at(-1);
  return (
    <section className="inc-investigation" aria-labelledby="inc-action-heading">
      <ol className="inc-steps" aria-label="Этапы расследования">
        {steps.map((step, index) => (
          <li
            key={step.phase}
            className={`${state.phase === step.phase ? 'inc-step-current' : ''} ${step.done ? 'inc-step-done' : ''}`}
            aria-current={state.phase === step.phase ? 'step' : undefined}
          >
            <span>{step.done ? <Check size={14} /> : index + 1}</span>
            {step.title}
          </li>
        ))}
      </ol>
      <div className="inc-action-heading">
        <h3 id="inc-action-heading">
          {state.recoveryRequired
            ? 'Нужна отдельная процедура восстановления'
            : phaseLabels[state.phase]}
        </h3>
        {state.phase === 'observe' && <span>{state.observed.length} / 2 наблюдения</span>}
      </div>
      {state.recoveryRequired && (
        <div className="inc-recovery">
          <TriangleAlert size={23} />
          <div>
            <p>
              Учебная история потеряна. Следующее изменение конфигурации её не восстановит. В
              реальной системе нужны резервная копия и отдельная проверка восстановления.
            </p>
            <button className="outline" disabled={busy} onClick={() => setResetConfirm(true)}>
              Начать сценарий заново
              <RotateCcw size={15} />
            </button>
          </div>
        </div>
      )}
      {panel && !state.recoveryRequired && (
        <>
          <p>{panel.help}</p>
          <div className="inc-choice-list">
            {panel.choices.map((choice) => {
              const observed = panel.action === 'observe' && state.observed.includes(choice.id);
              return (
                <button
                  className={`inc-choice ${observed ? 'inc-choice-observed' : ''}`}
                  key={choice.id}
                  disabled={busy || observed}
                  onClick={() => act(panel.action, choice.id)}
                >
                  <span>
                    {observed ? (
                      <CheckCircle2 size={18} />
                    ) : panel.action === 'observe' ? (
                      <Search size={18} />
                    ) : (
                      <ArrowRight size={18} />
                    )}
                  </span>
                  <span>{choice.label}</span>
                  {observed && <small>Проверено</small>}
                </button>
              );
            })}
          </div>
        </>
      )}
      {state.phase === 'verify' && (
        <div className="inc-verify">
          <ShieldCheck size={27} />
          <div>
            <p>
              Изменение применено. Теперь проверьте метрики и бизнес-результат: только эта проверка
              завершает расследование.
            </p>
            <button className="primary" disabled={busy} onClick={() => act('verify')}>
              Проверить восстановление
              <ArrowRight size={17} />
            </button>
          </div>
        </div>
      )}
      {state.verified && (
        <div className="inc-solved">
          <CheckCircle2 size={27} />
          <div>
            <strong>Решение проверено и сохранено</strong>
            <p>
              Вы связали симптомы с причиной, внесли изменение и отдельно подтвердили результат.
              Выберите следующий случай или повторите этот.
            </p>
          </div>
        </div>
      )}
      {latest && (
        <div className={`inc-feedback inc-feedback-${latest.kind}`} role="status">
          <strong>
            {busy
              ? 'Проверяем действие…'
              : latest.kind === 'error'
                ? 'Нужно другое решение'
                : latest.kind === 'warning'
                  ? 'Обратите внимание'
                  : 'Последнее наблюдение'}
          </strong>
          <p>{latest.text}</p>
        </div>
      )}
      {state.phase !== 'observe' && !state.recoveryRequired && (
        <details className="inc-evidence">
          <summary>
            Дополнительные наблюдения ({state.observed.length} / {incident.observations.length})
          </summary>
          <p>
            Если фактов недостаточно для выбора причины, выполните оставшиеся проверки. Собранные
            результаты доступны в истории расследования.
          </p>
          <div className="inc-choice-list">
            {incident.observations.map((observation) => {
              const observed = state.observed.includes(observation.id);
              return (
                <button
                  key={observation.id}
                  className={`inc-choice ${observed ? 'inc-choice-observed' : ''}`}
                  disabled={busy || observed || state.verified}
                  onClick={() => act('observe', observation.id)}
                >
                  <span>{observed ? <CheckCircle2 size={17} /> : <Search size={17} />}</span>
                  <span>{observation.label}</span>
                  {observed && <small>Проверено</small>}
                </button>
              );
            })}
          </div>
        </details>
      )}
      <div className="inc-investigation-footer">
        <span>Действий: {state.attempts}</span>
        <button className="text" disabled={busy} onClick={() => setResetConfirm(true)}>
          <RotateCcw size={14} />
          Повторить с начала
        </button>
      </div>
      {resetConfirm && (
        <div className="inc-reset-confirm" role="group" aria-label="Подтверждение сброса сценария">
          <strong>Начать этот случай заново?</strong>
          <p>
            История действий и результат этого сценария будут удалены. Уроки и другие случаи
            сохранятся.
          </p>
          <div className="button-row">
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                setResetConfirm(false);
                act('reset');
              }}
            >
              Да, начать заново
            </button>
            <button className="outline" onClick={() => setResetConfirm(false)}>
              Отмена
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function Incidents() {
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [saved, setSaved] = useState<Record<string, IncidentState>>({});
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const requestId = useRef(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api<{ incidents: Incident[]; progress?: Record<string, IncidentState> }>('incidents')
      .then((data) => {
        if (!active) return;
        setIncidents(data.incidents);
        setSaved(data.progress ?? {});
        setSelected((current) =>
          data.incidents.some((incident) => incident.id === current)
            ? current
            : (data.incidents[0]?.id ?? ''),
        );
        if (!data.incidents.length) setLoading(false);
      })
      .catch((reason) => {
        if (active) {
          setError((reason as Error).message);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [reload]);

  useEffect(() => {
    if (!selected) return;
    let active = true;
    const id = ++requestId.current;
    setDetail(null);
    setLoading(true);
    setError('');
    api<Detail>(`incidents/${encodeURIComponent(selected)}`)
      .then((data) => {
        if (!active || id !== requestId.current) return;
        setDetail(data);
        setSaved((previous) => ({ ...previous, [data.incident.id]: data.state }));
        setLoading(false);
      })
      .catch((reason) => {
        if (active) {
          setError((reason as Error).message);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [selected, reload]);

  async function act(action: Action, choice?: string) {
    if (busy || !detail) return;
    const id = ++requestId.current;
    setBusy(true);
    setError('');
    try {
      const data = await api<Detail>(`incidents/${encodeURIComponent(detail.incident.id)}`, {
        action,
        ...(choice ? { choice } : {}),
      });
      if (id !== requestId.current) return;
      setDetail(data);
      setSaved((previous) => ({ ...previous, [data.incident.id]: data.state }));
    } catch (reason) {
      if (id === requestId.current) setError((reason as Error).message);
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }

  const completed = incidents.filter((incident) => saved[incident.id]?.verified).length;
  return (
    <div className="incidents-page">
      <div className="page-heading">
        <h1>Реальные проблемы Kafka</h1>
        <p>
          Разберите повседневные сбои: соберите факты, найдите причину и проверьте исправление.
          Каждый шаг меняет модель системы.
        </p>
      </div>
      <div className="inc-model-banner">
        <Info size={18} />
        <p>
          <strong>Учебная модель инцидента.</strong> Значения заданы сценарием, а не получены из
          работающего Kafka. Движение событий помогает увидеть последствия решений.
        </p>
        <span>
          {completed} / {incidents.length || 6} проверено
        </span>
      </div>
      <div className="inc-layout">
        <nav className="inc-catalogue" aria-label="Сценарии проблем Kafka">
          <h2>Выберите случай</h2>
          {incidents.map((incident, index) => (
            <button
              key={incident.id}
              className={`inc-case ${selected === incident.id ? 'inc-case-selected' : ''}`}
              onClick={() => setSelected(incident.id)}
              disabled={busy}
              aria-current={selected === incident.id ? 'true' : undefined}
            >
              <span className="inc-case-number">
                {saved[incident.id]?.verified ? (
                  <CheckCircle2 size={18} />
                ) : (
                  String(index + 1).padStart(2, '0')
                )}
              </span>
              <span>
                <strong>{incident.title}</strong>
                <small>{incident.summary}</small>
              </span>
              <ArrowRight size={15} />
            </button>
          ))}
          {!incidents.length && loading && <p role="status">Загружаем случаи…</p>}
          <div className="inc-method">
            <strong>Порядок имеет значение</strong>
            <span>
              Наблюдения
              <ArrowDown size={13} />
              Гипотеза
              <ArrowDown size={13} />
              Исправление
              <ArrowDown size={13} />
              Проверка
            </span>
          </div>
        </nav>
        <div className="inc-workspace" aria-busy={busy || loading}>
          {error && (
            <div className="inc-error" role="alert">
              <strong>Не удалось выполнить действие</strong>
              <p>{error}</p>
              <button
                className="outline"
                disabled={busy}
                onClick={() => setReload((value) => value + 1)}
              >
                Обновить состояние
              </button>
            </div>
          )}
          {loading && (
            <div className="inc-loading" role="status">
              <Activity size={24} />
              <span>Открываем состояние сценария…</span>
            </div>
          )}
          {!loading && detail && (
            <>
              <header className="inc-case-heading">
                <span className="inc-eyebrow">{phaseLabels[detail.state.phase]}</span>
                <h2>{detail.incident.title}</h2>
                <p>{detail.incident.symptom}</p>
                <div className="inc-impact">
                  <TriangleAlert size={16} />
                  <span>{detail.incident.impact}</span>
                </div>
              </header>
              <FlowPlayback key={detail.incident.id} {...detail} />
              <Investigation key={detail.incident.id} {...detail} busy={busy} act={act} />
              <details className="inc-sources">
                <summary>Документация для этого случая</summary>
                {detail.incident.sources.map((source) => (
                  <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                    {source.title}
                    <ArrowUpRight size={15} />
                  </a>
                ))}
              </details>
            </>
          )}
          {!loading && !incidents.length && !error && (
            <p className="empty">Сценарии пока недоступны.</p>
          )}
        </div>
      </div>
    </div>
  );
}
