import { useEffect, useState, type CSSProperties } from 'react';
import { ArrowDownToLine, Check, Pause, Play, Plus, RotateCcw } from 'lucide-react';
import { initialState, produce, readBatch, commit, restart, lag } from './model';
import { useSceneMotion } from './useSceneMotion';
function seeded() {
  let s = initialState();
  for (let i = 0; i < 9; i++) s = produce(s, 'order-' + i, 'created');
  return s;
}
export function StreamGallery() {
  const [s, set] = useState(seeded);
  const [paused, pause] = useState(false);
  const [selected, select] = useState(0);
  const [arrival, setArrival] = useState<string | null>(null);
  const [message, messageSet] = useState('9 событий в трёх партициях. Чтение и commit независимы.');
  const { ref, eligible, reduced } = useSceneMotion();
  useEffect(() => {
    if (reduced) setArrival(null);
  }, [reduced]);
  const group = s.groups.billing;
  const count = s.partitions.flat().length;
  function action(kind: string) {
    if (kind === 'produce') {
      const next = produce(s, 'order-' + count, 'created');
      set(next);
      const p = next.partitions.findIndex((r, i) => r.length > s.partitions[i].length);
      select(p);
      setArrival(eligible && !paused ? 'order-' + count : null);
      messageSet('Записано order-' + count + ' в P' + p + '. Lag вырос.');
    }
    if (kind === 'read') {
      const next = readBatch(s, 'billing');
      set(next);
      messageSet(
        'Прочитано ' +
          next.lastRead.length +
          ' событий. Position сдвинут, committed остаётся прежним.',
      );
    }
    if (kind === 'commit') {
      set(commit(s, 'billing'));
      messageSet('Текущая позиция подтверждена. При рестарте чтение начнётся с committed.');
    }
    if (kind === 'restart') {
      set(restart(s, 'billing'));
      messageSet(
        'Position возвращён к committed. Неподтверждённые записи доступны для повторного чтения.',
      );
    }
  }
  return (
    <section
      ref={ref}
      className="stream-gallery"
      aria-label="Интерактивный журнал Kafka"
      data-motion={eligible && !paused ? 'running' : 'paused'}
    >
      <div className="gallery-caption">
        <span>ORDERS / 3 PARTITIONS</span>
        <button
          className="gallery-pause"
          onClick={() => pause(!paused)}
          aria-label={paused ? 'Включить движение журнала' : 'Приостановить движение журнала'}
        >
          {paused || reduced ? <Play size={14} /> : <Pause size={14} />}
          <span>{paused || reduced ? 'Статика' : 'Движение'}</span>
        </button>
      </div>
      <div className="partition-switch" aria-label="Выбор партиции">
        {[0, 1, 2].map((p) => (
          <button
            key={p}
            aria-pressed={selected === p}
            onClick={() => {
              select(p);
              setArrival(null);
            }}
          >
            P{p} · {s.partitions[p].length} записей
          </button>
        ))}
      </div>
      <div className="partition-gallery">
        {s.partitions.map((rows, p) => (
          <article
            key={p}
            className="gallery-partition"
            data-selected={selected === p}
            style={{ '--p': p } as CSSProperties}
            aria-label={'Партиция ' + p}
          >
            <header>
              <span>PARTITION</span>
              <strong>0{p}</strong>
            </header>
            <div className="partition-shaft">
              <div className="shaft-rail" />
              {rows.slice(-7).map((r, i) => (
                <div
                  key={r.offset}
                  className={
                    'gallery-record ' +
                    (arrival === r.key ? 'is-arriving ' : '') +
                    (r.offset < group.committed[p]
                      ? 'is-committed'
                      : r.offset < group.position[p]
                        ? 'is-read'
                        : '')
                  }
                  style={{ '--i': i } as CSSProperties}
                  onAnimationEnd={() => {
                    if (arrival === r.key) setArrival(null);
                  }}
                >
                  <span>{r.key}</span>
                  <b>{String(r.offset).padStart(2, '0')}</b>
                  <i />
                </div>
              ))}
              <span className="shaft-base">APPEND ONLY</span>
            </div>
            <dl>
              <div>
                <dt>log end</dt>
                <dd>{rows.length}</dd>
              </div>
              <div>
                <dt>position</dt>
                <dd>{group.position[p]}</dd>
              </div>
              <div>
                <dt>committed</dt>
                <dd>{group.committed[p]}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
      <div className="gallery-console">
        <span>
          <b>{count}</b> событий · lag <b>{lag(s, 'billing')}</b>
        </span>
        <span>billing / учебная модель</span>
      </div>
      <div className="gallery-actions">
        <button disabled={count >= 21} onClick={() => action('produce')}>
          <Plus size={15} />
          Записать
        </button>
        <button onClick={() => action('read')}>
          <ArrowDownToLine size={15} />
          Прочитать
        </button>
        <button onClick={() => action('commit')}>
          <Check size={15} />
          Commit
        </button>
        <button onClick={() => action('restart')}>
          <RotateCcw size={15} />
          Рестарт
        </button>
      </div>
      <p className="gallery-status" role="status">
        {message}
      </p>
      <div className="gallery-footnote">
        <span>
          Янтарь: ожидание · светлый: прочитано · зелёный: commit. Окно до 7 записей на партицию.
        </span>
        <button
          onClick={() => {
            set(seeded());
            setArrival(null);
            select(0);
            messageSet('Модель сброшена. 9 событий, позиции и commits равны нулю.');
          }}
        >
          Сброс
        </button>
      </div>
    </section>
  );
}
