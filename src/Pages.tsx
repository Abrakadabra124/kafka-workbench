import { useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Download,
  RotateCcw,
  Search,
} from 'lucide-react';
import type { Module, Progress } from './types';
import { api } from './api';
import { FlowDiagram } from './Sandbox';

export function Dashboard({ modules, progress }: { modules: Module[]; progress: Progress }) {
  const lessons = modules.flatMap((m) => m.lessons);
  const next = lessons.find((l) => !progress.completed.includes(l.id)) ?? lessons[0];
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <h1>
            Понимать потоки.
            <br />
            Управлять событиями.
          </h1>
          <p>
            Разберитесь в Kafka на практике: от первого события до надёжной обработки и разбора
            инцидентов.
          </p>
          <div className="hero-actions">
            <a className="button primary" href={`#lesson/${next.id}`}>
              {progress.completed.length ? 'Продолжить обучение' : 'Начать обучение'}
              <ArrowRight size={18} />
            </a>
            <a className="button text" href="#curriculum">
              Изучить программу
              <ArrowRight size={18} />
            </a>
          </div>
        </div>
        <FlowDiagram />
      </section>
      <div className="facts">
        <div>
          <strong>{String(modules.length).padStart(2, '0')}</strong>
          <span>модулей</span>
        </div>
        <div>
          <strong>{lessons.length}</strong>
          <span>уроков</span>
        </div>
        <div>
          <strong>Практика с настоящим Kafka</strong>
          <span>Настраивайте, запускайте, экспериментируйте</span>
        </div>
      </div>
      <section className="route-preview">
        <div className="section-heading">
          <h2>Ваш учебный маршрут</h2>
          <a href="#curriculum">
            Вся программа
            <ArrowRight size={18} />
          </a>
        </div>
        <div className="module-list">
          {modules.slice(0, 3).map((m, i) => (
            <a className="module-row" key={m.id} href={`#lesson/${m.lessons[0].id}`}>
              <span className="ordinal" aria-hidden="true">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="module-copy">
                <strong>{m.title}</strong>
                <span>{m.description}</span>
              </span>
              <span className="module-meta">{m.lessons.length} урока</span>
              <ArrowRight className="accent" size={19} />
            </a>
          ))}
        </div>
      </section>
      <div className="incident-prompt">
        <div>
          <strong>Когда что-то пошло не так</strong>
          <p>Разберите рабочий инцидент: от первых симптомов до проверенного восстановления.</p>
        </div>
        <a className="button outline" href="#incidents">
          Реальные проблемы
          <ArrowRight size={18} />
        </a>
      </div>
    </>
  );
}
export function Curriculum({ modules, progress }: { modules: Module[]; progress: Progress }) {
  const [search, setSearch] = useState('');
  const normalized = search.trim().toLocaleLowerCase('ru');
  const found = modules
    .map((m) => ({
      ...m,
      lessons: m.lessons.filter((l) =>
        `${m.title} ${l.title} ${l.objective}`.toLocaleLowerCase('ru').includes(normalized),
      ),
    }))
    .filter((m) => m.lessons.length);
  return (
    <>
      <div className="page-heading">
        <h1>Учебный маршрут</h1>
        <p>
          От устройства журнала до решений, которые выдерживают сбои. Идите по порядку или выберите
          свою тему.
        </p>
      </div>
      <label className="search">
        <Search size={19} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Найти урок: offsets, доставка, KRaft…"
          aria-label="Найти урок"
        />
        <kbd>18 уроков</kbd>
      </label>
      <div className="curriculum">
        {found.map((m) => (
          <details key={m.id} open>
            <summary>
              <span className="ordinal">
                {String(modules.findIndex((x) => x.id === m.id) + 1).padStart(2, '0')}
              </span>
              <div>
                <h2>{m.title}</h2>
                <p>{m.description}</p>
              </div>
              <ChevronDown size={19} />
            </summary>
            <div className="lesson-list">
              {m.lessons.map((l) => (
                <a href={`#lesson/${l.id}`} key={l.id}>
                  <span className={`lesson-dot ${progress.completed.includes(l.id) ? 'done' : ''}`}>
                    {progress.completed.includes(l.id) && <Check size={13} />}
                  </span>
                  <span>{l.title}</span>
                  <small>{l.duration} мин</small>
                  <ArrowRight size={16} />
                </a>
              ))}
            </div>
          </details>
        ))}
      </div>
      {!found.length && (
        <p role="status" className="empty">
          Ничего не найдено. Попробуйте «группы» или «offset».
        </p>
      )}
    </>
  );
}
export function ProgressPage({
  modules,
  progress,
  onProgress,
}: {
  modules: Module[];
  progress: Progress;
  onProgress: (p: Progress) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const lessons = modules.flatMap((m) => m.lessons);
  const retry = lessons.filter((l) =>
    Object.values(progress.answers[l.id] ?? {}).some((a) => !a.correct),
  );
  const percent = Math.round((progress.completed.length / lessons.length) * 100);
  async function reset() {
    setResetting(true);
    try {
      await api('progress/reset', { confirm: 'RESET' });
      onProgress(await api<Progress>('progress'));
      setConfirm(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResetting(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <h1>Мой прогресс</h1>
        <p>Освоение считается по двум проверкам в каждом уроке: понимание и инженерное решение.</p>
      </div>
      <div className="progress-overview">
        <div className="progress-number">
          {percent}
          <span>%</span>
        </div>
        <div>
          <h2>
            {progress.completed.length} из {lessons.length} уроков пройдено
          </h2>
          <progress
            value={progress.completed.length}
            max={lessons.length}
            aria-label="Освоение программы"
          />
          <p>Это результат учебной программы, а не профессиональная сертификация.</p>
        </div>
        <a className="button outline" href="/api/export" download="kafka-progress.json">
          <Download size={18} />
          Экспорт прогресса
        </a>
      </div>
      <h2>По модулям</h2>
      <div className="module-list">
        {modules.map((m, i) => (
          <a className="module-row" href={`#lesson/${m.lessons[0].id}`} key={m.id}>
            <span className="ordinal">0{i + 1}</span>
            <span className="module-copy">
              <strong>{m.title}</strong>
              <progress
                value={m.lessons.filter((l) => progress.completed.includes(l.id)).length}
                max={m.lessons.length}
                aria-label={m.title}
              />
            </span>
            <span>
              {m.lessons.filter((l) => progress.completed.includes(l.id)).length}/{m.lessons.length}
            </span>
            <ArrowRight size={18} />
          </a>
        ))}
      </div>
      <section className="repeat-section">
        <h2>Вернуться к сложному</h2>
        {retry.length ? (
          <div className="lesson-list">
            {retry.map((l) => (
              <a key={l.id} href={`#lesson/${l.id}`}>
                <RotateCcw size={18} />
                <span>{l.title}</span>
                <ArrowRight size={18} />
              </a>
            ))}
          </div>
        ) : (
          <p>
            Здесь появятся уроки с ошибками в последней попытке. Ошибаться и пробовать снова - часть
            обучения.
          </p>
        )}
      </section>
      <details className="reset-section">
        <summary>Управление локальными данными</summary>
        <p>
          Один учебный профиль на эту установку. Сброс удалит результаты уроков, заметки и истории
          всех инцидентов. Сначала скачайте экспорт.
        </p>
        {!confirm ? (
          <button className="outline danger" onClick={() => setConfirm(true)}>
            Сбросить прогресс
          </button>
        ) : (
          <div className="button-row">
            <strong>Удалить результаты, заметки и истории инцидентов?</strong>
            <button className="danger" disabled={resetting} onClick={reset}>
              Да, удалить
            </button>
            <button className="outline" onClick={() => setConfirm(false)}>
              Отмена
            </button>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </details>
    </>
  );
}
export function Sources({ modules }: { modules: Module[] }) {
  const sources = [
    ...new Map(
      modules.flatMap((m) => m.lessons.flatMap((l) => l.sources)).map((s) => [s.url, s]),
    ).values(),
  ];
  return (
    <>
      <div className="page-heading">
        <h1>Источники и границы модели</h1>
        <p>
          Материалы сверены с документацией Apache Kafka и Confluent. В лаборатории закреплён Apache
          Kafka 4.2.2.
        </p>
      </div>
      <div className="note">
        <strong>Что именно вы изучаете</strong>
        <p>
          Песочница показывает упрощённый журнал и обычные consumer groups. Хеширование ключа,
          распределение партиций и пошаговое чтение учебные. Реальные таймеры, сеть, репликация,
          retention и транзакции здесь не исполняются. Share groups отличаются и в модель не входят.
        </p>
        <p>
          Настоящая лаборатория использует отдельный брокер Kafka. Один брокер позволяет проверять
          запись и чтение, но не отказоустойчивость кластера.
        </p>
      </div>
      <h2>Первоисточники</h2>
      <div className="source-list">
        {sources.map((s) => (
          <a href={s.url} key={s.url} target="_blank" rel="noreferrer">
            <span>
              {s.title}
              <small>{new URL(s.url).hostname}</small>
            </span>
            <ArrowUpRight size={18} />
          </a>
        ))}
      </div>
      <p className="muted">
        Сравнение учебных подходов и критерии качества находятся в{' '}
        <a
          href="https://github.com/Abrakadabra124/kafka-workbench/blob/main/docs/RESEARCH.md"
          target="_blank"
          rel="noreferrer"
        >
          исследовании проекта
        </a>
        . Дата исследования: 7 октября 2026 года.
      </p>
    </>
  );
}
