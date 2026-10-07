import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, Clock, Lightbulb, Save } from 'lucide-react';
import { api } from './api';
import type { Assessment, Lesson, Progress } from './types';

function Question({
  assessment,
  kind,
  lessonId,
  onProgress,
}: {
  assessment: Assessment;
  kind: 'question' | 'scenario';
  lessonId: string;
  onProgress: Dispatch<SetStateAction<Progress>>;
}) {
  const [choice, setChoice] = useState<number | null>(null);
  const [result, setResult] = useState<{ correct: boolean; explanation: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setBusy(true);
    setError('');
    try {
      const response = await api<{ correct: boolean; explanation: string; progress: Progress }>(
        'answer',
        { lessonId, kind, choice },
      );
      setResult(response);
      onProgress((previous) => {
        const answers = { ...previous.answers };
        for (const [id, values] of Object.entries(response.progress.answers)) {
          answers[id] = { ...answers[id] };
          for (const type of ['question', 'scenario'] as const) {
            if (values[type] && values[type]!.attempts >= (answers[id][type]?.attempts ?? 0))
              answers[id][type] = values[type];
          }
        }
        return {
          ...previous,
          answers,
          completed: [...new Set([...previous.completed, ...response.progress.completed])],
        };
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="assessment" aria-labelledby={`${kind}-heading`}>
      <div className="section-index">
        {kind === 'question' ? '01 / Проверка понимания' : '02 / Инженерная ситуация'}
      </div>
      <h2 id={`${kind}-heading`}>{assessment.prompt}</h2>
      <fieldset disabled={busy}>
        <legend className="sr-only">Выберите один ответ</legend>
        {assessment.options.map((option, i) => (
          <label className={`answer-option ${choice === i ? 'selected' : ''}`} key={i}>
            <input
              type="radio"
              name={kind}
              checked={choice === i}
              onChange={() => {
                setChoice(i);
                setResult(null);
              }}
            />
            <span className="option-letter">{String.fromCharCode(65 + i)}</span>
            <span>{option}</span>
          </label>
        ))}
      </fieldset>
      <button className="primary" disabled={choice === null || busy} onClick={submit}>
        {busy ? 'Проверяем…' : 'Проверить ответ'}
        <ArrowRight size={17} />
      </button>
      {result && (
        <div className={`feedback ${result.correct ? 'success' : 'retry'}`} role="status">
          <strong>
            {result.correct ? 'Верно. Разберём почему.' : 'Пока не совсем. Разберём решение.'}
          </strong>
          <p>{result.explanation}</p>
          {!result.correct && <span>Выберите другой ответ и попробуйте снова.</span>}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
export function LessonView({
  lesson,
  lessons,
  progress,
  onProgress: updateProgress,
}: {
  lesson: Lesson;
  lessons: Lesson[];
  progress: Progress;
  onProgress: Dispatch<SetStateAction<Progress>>;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onProgress: Dispatch<SetStateAction<Progress>> = (value) => {
    if (mounted.current) updateProgress(value);
  };
  const [tab, setTab] = useState<'theory' | 'practice' | 'notes'>('theory');
  const [note, setNote] = useState(progress.notes[lesson.id] ?? '');
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const index = lessons.findIndex((l) => l.id === lesson.id);
  const completed = progress.completed.includes(lesson.id);
  async function save() {
    setSaving(true);
    setSaved('');
    try {
      await api('notes', { lessonId: lesson.id, text: note });
      onProgress((previous) => ({ ...previous, notes: { ...previous.notes, [lesson.id]: note } }));
      setSaved('Заметка сохранена.');
    } catch (e) {
      setSaved((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <article className="lesson-view">
      <a href="#curriculum" className="back-link">
        <ArrowLeft size={16} />К программе
      </a>
      <div className="lesson-topline">
        <span>
          Урок {String(index + 1).padStart(2, '0')} / {lessons.length}
        </span>
        <span>
          <Clock size={15} />
          {lesson.duration} мин
        </span>
        {completed && (
          <span className="completed">
            <Check size={16} />
            Пройден
          </span>
        )}
      </div>
      <h1>{lesson.title}</h1>
      <p className="lesson-objective">{lesson.objective}</p>
      <div className="tabs" aria-label="Части урока">
        {(
          [
            { id: 'theory', label: 'Разобраться' },
            { id: 'practice', label: 'Проверить себя' },
            { id: 'notes', label: 'Мои заметки' },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'selected' : ''}
            aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'theory' ? (
        <div className="lesson-body">
          <div className="prose">
            {lesson.theory.map((section, i) => (
              <section key={i}>
                <h2>{section.title}</h2>
                {section.body.split('\n\n').map((paragraph, j) => (
                  <p key={j}>{paragraph}</p>
                ))}
              </section>
            ))}
            <div className="takeaways">
              <h2>
                <Lightbulb size={21} />
                Что нужно запомнить
              </h2>
              <ul>
                {lesson.takeaways.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </div>
            <button className="primary" onClick={() => setTab('practice')}>
              Перейти к проверке
              <ArrowRight size={18} />
            </button>
          </div>
          <aside className="lesson-aside">
            <h3>Изучите на практике</h3>
            <p>Отправьте событие, прочитайте его и сравните позицию чтения с сохранённым offset.</p>
            <a className="button outline" href="#sandbox">
              Открыть песочницу
              <ArrowUpRight size={17} />
            </a>
            <h3>Первоисточники</h3>
            {lesson.sources.map((s) => (
              <a className="source-link" key={s.url} href={s.url} target="_blank" rel="noreferrer">
                {s.title}
                <ArrowUpRight size={15} />
              </a>
            ))}
          </aside>
        </div>
      ) : tab === 'practice' ? (
        <div className="practice-body">
          <p className="muted">
            Для завершения урока решите обе задачи. После ответа появится объяснение. Повторные
            попытки сохраняются.
          </p>
          <Question
            lessonId={lesson.id}
            kind="question"
            assessment={lesson.question}
            onProgress={onProgress}
          />
          <Question
            lessonId={lesson.id}
            kind="scenario"
            assessment={lesson.scenario}
            onProgress={onProgress}
          />
          {completed && (
            <div className="completion">
              <Check size={23} />
              <div>
                <strong>Урок освоен</strong>
                <p>Обе проверки пройдены. Закрепите тему экспериментом или двигайтесь дальше.</p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <section className="notes">
          <h2>Рабочая тетрадь</h2>
          <p>
            Запишите, как вы объяснили бы эту тему коллеге. Что случится при сбое и как вы это
            проверите?
          </p>
          <label htmlFor="lesson-note">Ваши наблюдения</label>
          <textarea
            disabled={saving}
            id="lesson-note"
            rows={10}
            maxLength={10000}
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setSaved('');
            }}
            placeholder="Моё объяснение, наблюдения из песочницы, вопросы…"
          />
          <div className="button-row">
            <button className="primary" disabled={saving} onClick={save}>
              <Save size={17} />
              {saving ? 'Сохраняем…' : 'Сохранить заметку'}
            </button>
            <span role="status">{saved}</span>
          </div>
          <small>{note.length} / 10 000 символов. Перед уходом из урока сохраните изменения.</small>
        </section>
      )}
      <nav className="lesson-pagination" aria-label="Уроки">
        {index > 0 ? (
          <a className="button outline" href={`#lesson/${lessons[index - 1].id}`}>
            <ArrowLeft size={17} />
            Предыдущий урок
          </a>
        ) : (
          <span />
        )}
        {index < lessons.length - 1 ? (
          <a className="button outline" href={`#lesson/${lessons[index + 1].id}`}>
            Следующий урок
            <ArrowRight size={17} />
          </a>
        ) : (
          <a className="button primary" href="#progress">
            Посмотреть результат
            <ArrowRight size={17} />
          </a>
        )}
      </nav>
    </article>
  );
}
