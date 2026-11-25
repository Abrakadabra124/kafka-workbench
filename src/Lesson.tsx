import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { ArrowLeft, ArrowRight, Check, Clock, Save } from 'lucide-react';
import { api } from './api';
import type { Assessment, Lesson, Progress } from './types';
import { LearningPath } from './LearningPath';

function Question({
  assessment,
  kind,
  lessonId,
  attempts,
  onProgress,
}: {
  assessment: Assessment;
  kind: 'question' | 'scenario';
  lessonId: string;
  attempts: number;
  onProgress: Dispatch<SetStateAction<Progress>>;
}) {
  const draftKey = `kafka-answer:${lessonId}:${kind}`;
  const [choice, setChoice] = useState<number | null>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) ?? 'null');
      return Number.isInteger(saved) && saved >= 0 && saved < assessment.options.length
        ? saved
        : null;
    } catch {
      return null;
    }
  });
  const [result, setResult] = useState<{
    correct: boolean;
    explanation: string;
    hint: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit() {
    setBusy(true);
    setError('');
    try {
      const response = await api<{
        correct: boolean;
        explanation: string;
        hint: string;
        progress: Progress;
      }>('answer', { lessonId, kind, choice });
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
      {attempts > 0 && (
        <p className="muted">
          Сохранено попыток: {attempts}. Можно пересмотреть ответ и проверить его снова.
        </p>
      )}
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
                try {
                  localStorage.setItem(draftKey, JSON.stringify(i));
                } catch {
                  /* Practice remains usable when browser storage is unavailable. */
                }
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
          {!result.correct && (
            <p>
              <strong>Подсказка: </strong>
              {result.hint} Выберите другой ответ и попробуйте снова.
            </p>
          )}
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
  const [notesOpen, setNotesOpen] = useState(false);
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
      <LearningPath
        id={`lesson/${lesson.id}`}
        sources={lesson.sources}
        theory={
          <div className="prose">
            {lesson.theory.map((section) => (
              <section key={section.title}>
                <h3>{section.title}</h3>
                {section.body.split('\n\n').map((paragraph, i) => (
                  <p key={i}>{paragraph}</p>
                ))}
              </section>
            ))}
            <div className="takeaways">
              <h3>Что нужно запомнить</h3>
              <ul>
                {lesson.takeaways.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </div>
          </div>
        }
      >
        <div className="practice-body">
          <p className="muted">
            Для завершения урока решите обе задачи. После ответа появится объяснение. Повторные
            попытки сохраняются.
          </p>
          <Question
            lessonId={lesson.id}
            attempts={progress.answers[lesson.id]?.question?.attempts ?? 0}
            kind="question"
            assessment={lesson.question}
            onProgress={onProgress}
          />
          <Question
            lessonId={lesson.id}
            attempts={progress.answers[lesson.id]?.scenario?.attempts ?? 0}
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
      </LearningPath>
      <button
        className="outline"
        aria-expanded={notesOpen}
        aria-controls="lesson-notes"
        onClick={() => setNotesOpen(!notesOpen)}
      >
        Мои заметки
      </button>
      <div id="lesson-notes" hidden={!notesOpen} className="learning-content">
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
            <small>{note.length} / 10 000</small>
          </div>
          <small>Перед уходом из урока сохраните изменения.</small>
        </section>
      </div>
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
