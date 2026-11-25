import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { useSceneMotion } from './useSceneMotion';
import './learning-path.css';

type Guide = {
  problem: string;
  terms: { term: string; meaning: string }[];
  mechanism: string[];
  documentation: {
    title: string;
    syntax: string;
    explanation: string;
    check: string;
    limitation: string;
  }[];
  example: {
    title: string;
    context: string;
    steps: {
      title: string;
      action: string;
      nodes: { label: string; value: string }[];
      reason: string;
      evidence: string;
    }[];
  };
  goal: string;
  success: string;
  transfer: string;
  sources?: { title: string; url: string }[];
};
type PathState = { stage: number; unlocked: number };
type Payload = { guide: Guide; progress: PathState };
const stages = [
  'Урок на русском',
  'Русская документация',
  'Наглядный пример',
  'Самостоятельная практика',
];

function Example({ example, onComplete }: { example: Guide['example']; onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [seen, setSeen] = useState<number[]>([0]);
  const motion = useSceneMotion();
  useEffect(() => {
    if (motion.reduced) setPlaying(false);
  }, [motion.reduced]);
  const current = example.steps[step];
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;
  useEffect(() => {
    if (seen.length === example.steps.length) completeRef.current();
  }, [seen, example.steps.length]);
  function show(index: number) {
    setStep(index);
    setSeen((previous) => [...new Set([...previous, index])]);
  }
  useEffect(() => {
    if (!playing || !motion.eligible) return;
    if (step === example.steps.length - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(() => show(step + 1), 6500);
    return () => window.clearTimeout(timer);
  }, [playing, motion.eligible, step, example.steps.length]);
  return (
    <section className="learning-example" ref={motion.ref} aria-label="Пошаговый рабочий пример">
      <h3>{example.title}</h3>
      <p>{example.context}</p>
      <p className="muted">
        Учебный разбор. Переключение этапов меняет показанную модель и не запускает команды на
        брокере.
      </p>
      <div className="learning-example-controls">
        {example.steps.map((item, index) => (
          <button
            key={item.title}
            aria-pressed={step === index}
            onClick={() => {
              setPlaying(false);
              show(index);
            }}
          >
            {index + 1}. {item.title}
          </button>
        ))}
      </div>
      <div
        className="learning-diagram"
        data-motion={motion.eligible && playing ? 'playing' : 'paused'}
      >
        {current.nodes.map((node, index) => (
          <div className="learning-node" key={index}>
            <span>{node.label}</span>
            <strong>{node.value}</strong>
          </div>
        ))}
      </div>
      <div className="learning-frame" aria-live="polite" aria-atomic="true">
        <h4>
          {step + 1}. {current.title}
        </h4>
        <p>
          <strong>Действие: </strong>
          {current.action}
        </p>
        <p>
          <strong>Почему: </strong>
          {current.reason}
        </p>
        <p className="learning-evidence">
          <strong>Что проверить: </strong>
          {current.evidence}
        </p>
      </div>
      <div className="button-row">
        <button
          disabled={step === 0}
          onClick={() => {
            setPlaying(false);
            show(step - 1);
          }}
        >
          Предыдущий шаг
        </button>
        <button
          disabled={step === example.steps.length - 1}
          onClick={() => {
            setPlaying(false);
            show(step + 1);
          }}
        >
          Следующий шаг
        </button>
        <button
          aria-pressed={playing}
          disabled={motion.reduced}
          onClick={() => {
            if (step === example.steps.length - 1) show(0);
            setPlaying(!playing);
          }}
        >
          {playing ? 'Пауза примера' : 'Воспроизвести пример'}
        </button>
      </div>
      <p className="muted">
        {motion.reduced
          ? 'Уменьшенное движение: используйте кнопки шагов.'
          : 'Автопоказ останавливается вне экрана и на скрытой вкладке. Каждый шаг можно рассмотреть вручную.'}
      </p>
    </section>
  );
}

export function LearningPath({
  id,
  title,
  theory,
  sources,
  children,
}: {
  id: string;
  title?: string;
  theory?: ReactNode;
  sources?: Guide['sources'];
  children: ReactNode;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [exampleDone, setExampleDone] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const endpoint = `learning/${encodeURIComponent(id)}`;
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    setExampleDone(false);
    api<Payload>(endpoint)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((reason) => {
        if (active) setError(reason.message);
      });
    return () => {
      active = false;
    };
  }, [endpoint]);
  async function change(stage: number) {
    if (!data || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ progress: PathState }>(endpoint, { stage });
      setData((previous) => previous && { ...previous, progress: result.progress });
      requestAnimationFrame(() => {
        heading.current?.focus();
        heading.current?.scrollIntoView({ block: 'start' });
      });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return (
      <section className="learning-path">
        <p role={error ? 'alert' : 'status'}>{error || 'Загружаем учебный маршрут…'}</p>
        {error && (
          <button
            onClick={() => {
              setError('');
              api<Payload>(endpoint)
                .then(setData)
                .catch((reason) => setError(reason.message));
            }}
          >
            Повторить загрузку материала
          </button>
        )}
      </section>
    );
  const { guide, progress } = data;
  return (
    <section
      className="learning-path"
      aria-label={title ? `Учебный путь: ${title}` : 'Учебный путь'}
    >
      {title && <h2>{title}</h2>}
      <nav className="learning-stages" aria-label="Порядок занятия">
        {stages.map((label, index) => (
          <button
            key={label}
            aria-current={progress.stage === index ? 'step' : undefined}
            disabled={busy || index > progress.unlocked}
            onClick={() => void change(index)}
          >
            <span>{index + 1}</span>
            {label}
          </button>
        ))}
      </nav>
      <p className="learning-save">
        Место сохраняется автоматически. К пройденным частям можно вернуться без сброса практики.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <h2 ref={heading} tabIndex={-1} className="learning-stage-title">
        {progress.stage + 1}. {stages[progress.stage]}
      </h2>
      <div className="learning-content" hidden={progress.stage !== 0}>
        <h3>Рабочая задача</h3>
        <p>{guide.problem}</p>
        <h3>Слова и сокращения</h3>
        <dl className="learning-terms">
          {guide.terms.map((term) => (
            <div key={term.term}>
              <dt>{term.term}</dt>
              <dd>{term.meaning}</dd>
            </div>
          ))}
        </dl>
        {theory}
        <h3>Как работает механизм</h3>
        <ol>
          {guide.mechanism.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </div>
      <div className="learning-content" hidden={progress.stage !== 1}>
        <p>
          Справка для выполнения занятия. Имена параметров и команды сохранены в оригинале;
          назначение и проверка описаны по-русски.
        </p>
        {guide.documentation.map((section) => (
          <section className="learning-reference" key={section.title}>
            <h3>{section.title}</h3>
            <pre>
              <code>{section.syntax}</code>
            </pre>
            <p>{section.explanation}</p>
            <p>
              <strong>Проверка: </strong>
              {section.check}
            </p>
            <p>
              <strong>Ограничение: </strong>
              {section.limitation}
            </p>
          </section>
        ))}
        <h3>Первоисточники</h3>
        <ul>
          {(sources ?? guide.sources ?? []).map((source) => (
            <li key={source.url}>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.title}
              </a>{' '}
              <span>(на английском языке)</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="learning-content" hidden={progress.stage !== 2}>
        <Example key={id} example={guide.example} onComplete={() => setExampleDone(true)} />
      </div>
      <div className="learning-content" hidden={progress.stage !== 3}>
        <div className="learning-mission">
          <h3>Ваша задача</h3>
          <p>{guide.goal}</p>
          <p>
            <strong>Критерий успеха: </strong>
            {guide.success}
          </p>
        </div>
        {children}
        <aside className="learning-transfer">
          <h3>Примените в рабочем проекте</h3>
          <p>{guide.transfer}</p>
          <p>
            Зафиксируйте исходные данные, действие, результат проверки и границы вывода в заметках
            или рабочем журнале.
          </p>
        </aside>
      </div>
      {progress.stage < 3 && (
        <div className="learning-next">
          {progress.stage === 2 && !exampleDone && progress.unlocked < 3 && (
            <p>Рассмотрите каждый шаг примера, затем приступайте к своему заданию.</p>
          )}
          <button
            className="primary"
            disabled={busy || (progress.stage === 2 && !exampleDone && progress.unlocked < 3)}
            onClick={() => void change(progress.stage + 1)}
          >
            {busy ? 'Сохраняем…' : `Далее: ${stages[progress.stage + 1].toLowerCase()}`}
          </button>
          {progress.unlocked === 3 && (
            <button className="outline" onClick={() => void change(3)} disabled={busy}>
              Продолжить начатую практику
            </button>
          )}
        </div>
      )}
    </section>
  );
}
