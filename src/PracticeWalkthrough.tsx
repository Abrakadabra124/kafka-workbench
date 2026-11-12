import { useState } from 'react';
import { RotateCcw, Search, ShieldCheck, TriangleAlert } from 'lucide-react';
import { SpatialFlow } from './SpatialFlow';
import {
  initialPractice,
  practiceTransition,
  type PracticeAction,
  type PracticeId,
} from './practice-model';
const titles = {
  'poison-quarantine': [
    'Повреждённое событие',
    'Сохранить карантин и обработать',
    'Commit в конец',
    'Повторить тот же payload',
  ],
  'isr-write-gate': [
    'Граница гарантии записи',
    'Восстановить ISR и записать',
    'Снизить minISR',
    'Повторить запись без ремонта',
  ],
  'retention-gap': [
    'История, которой больше нет',
    'Восстановить из архива',
    'Перейти к latest',
    'Прочитать с earliest',
  ],
};
export function PracticeWalkthrough({ task }: { task: string }) {
  const id = task as PracticeId;
  const [s, set] = useState(() => initialPractice(id));
  const [title, repair, wrong1, wrong2] = titles[id];
  const act = (a: PracticeAction) => set((old) => practiceTransition(old, a));
  const blocked = s.fault && !s.repaired;
  const lanes: [string, string[]][] = [
    ['Source', s.source],
    [
      id === 'isr-write-gate' ? 'ISR ' + s.isr + ' / minISR ' + s.minIsr : 'Архив',
      id === 'isr-write-gate' ? [] : ['E0', 'E1', 'E2'],
    ],
    [
      id === 'poison-quarantine' ? 'Обработано' : 'Recovery',
      id === 'poison-quarantine' ? s.processed : s.recovered,
    ],
    ['Карантин', s.quarantine],
  ];
  return (
    <section className="practice-walkthrough" aria-label="Разбор причины и решения">
      <span className="eyebrow">01 / УЧЕБНАЯ МОДЕЛЬ</span>
      <h3>{title}</h3>
      <p>Каждое решение меняет состояние. Это модель механизма, не измерение Kafka.</p>
      <SpatialFlow
        mode="incident"
        lag={Math.max(0, 3 - s.committed)}
        duplicates={0}
        isr={s.isr}
        inRate={0}
        outRate={0}
        nodes={{
          producer: id === 'isr-write-gate' && s.isr < s.minIsr ? 'blocked' : 'healthy',
          broker: s.isr < 3 ? 'degraded' : 'healthy',
          consumer: blocked && id !== 'isr-write-gate' && s.position < 3 ? 'blocked' : 'healthy',
          external: s.repaired ? 'healthy' : 'degraded',
        }}
        partitions={[
          { count: s.source.length, position: s.position, committed: s.committed, owner: 0 },
          { count: 0, position: 0, committed: 0, owner: 1 },
          { count: 0, position: 0, committed: 0, owner: 2 },
        ]}
      />
      <div className="practice-evidence" aria-label="Состояние модели">
        {lanes.map(([name, items]) => (
          <div key={name}>
            <strong>{name}</strong>
            <div>
              {items.length ? (
                items.map((x) => (
                  <span key={x} className={x === 'E1' && name === 'Карантин' ? 'bad-record' : ''}>
                    {x}
                  </span>
                ))
              ) : (
                <small>пусто</small>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="practice-readout">
        log start {s.start} · position {s.position} · committed {s.committed} · решений {s.attempts}
      </div>
      <div className="practice-frame" role="status">
        <strong>{s.verified ? 'Модель проверена' : 'Наблюдение и последствия'}</strong>
        <p>{s.message}</p>
      </div>
      <div className="button-row">
        <button className="outline" disabled={s.fault} onClick={() => act('fault')}>
          <TriangleAlert size={16} />
          Воспроизвести
        </button>
        <button className="outline" disabled={!s.fault} onClick={() => act('inspect')}>
          <Search size={16} />
          Исследовать
        </button>
      </div>
      <fieldset className="practice-decision" disabled={!s.inspected}>
        <legend>Выберите действие и сравните результат</legend>
        <button className="outline" onClick={() => act('wrong1')}>
          {wrong1}
        </button>
        <button className="outline" onClick={() => act('wrong2')}>
          {wrong2}
        </button>
        <button className="primary" onClick={() => act('repair')}>
          {repair}
        </button>
      </fieldset>
      <div className="button-row">
        <button className="primary" onClick={() => act('verify')}>
          <ShieldCheck size={16} />
          Проверить модель
        </button>
        <button className="outline" onClick={() => act('reset')}>
          <RotateCcw size={16} />
          Сброс модели
        </button>
      </div>
    </section>
  );
}
