import { useState } from 'react';
import { ArrowRight, Check, Info, Play, RotateCcw, Send } from 'lucide-react';
import {
  assign,
  commit,
  initialState,
  lag,
  produce,
  readBatch,
  restart,
  type GroupId,
  type LogState,
} from './model';

export function FlowDiagram() {
  return (
    <div
      className="flow-diagram"
      role="img"
      aria-label="Producer записывает события в три партиции топика Kafka. Consumer читает журнал, события остаются в нём."
    >
      <div className="flow-endpoint">Producer</div>
      <div className="flow-arrow">
        <i />
        <i />
        <i />
        <ArrowRight size={21} />
      </div>
      <div className="flow-broker">
        <span className="flow-title">
          Kafka <span>(топик: events)</span>
        </span>
        {[0, 1, 2].map((p) => (
          <div className="flow-partition" key={p}>
            <code>p{p}</code>
            <div>
              {Array.from({ length: 6 }, (_, i) => (
                <i key={i} className={i < 3 ? 'hot' : ''} />
              ))}
            </div>
            <small>
              offsets:
              <br />0 .. 5
            </small>
          </div>
        ))}
        <span className="flow-caption">запись в лог (append-only)</span>
      </div>
      <div className="flow-arrow">
        <i />
        <i />
        <ArrowRight size={21} />
      </div>
      <div className="flow-endpoint">Consumer</div>
    </div>
  );
}
export function Sandbox() {
  const [state, setState] = useState(initialState);
  const [group, setGroup] = useState<GroupId>('billing');
  const [consumers, setConsumers] = useState(2);
  const [key, setKey] = useState('order-42');
  const [value, setValue] = useState('Заказ создан');
  const [message, setMessage] = useState('Отправьте первое событие.');
  const [journal, setJournal] = useState<string[]>([]);
  const [restarted, setRestarted] = useState(false);
  const [redelivered, setRedelivered] = useState(false);
  const [seen, setSeen] = useState<string[]>([]);
  const [selected, setSelected] = useState<{ partition: number; offset: number } | null>(null);
  const assignments = assign(3, consumers);
  const current = state.groups[group];
  const event = selected ? state.partitions[selected.partition][selected.offset] : undefined;
  function log(text: string) {
    setMessage(text);
    setJournal((previous) => [text, ...previous].slice(0, 12));
  }
  function send() {
    try {
      const next = produce(state, key, value);
      const p = next.partitions.findIndex(
        (records, i) => records.length > state.partitions[i].length,
      );
      setState(next);
      log(`Записано: p${p}, offset ${next.partitions[p].length - 1}, key=${key}.`);
    } catch (e) {
      log((e as Error).message);
    }
  }
  function read() {
    const next = readBatch(state, group);
    const identities = next.lastRead.map((r) => `${group}:${r.partition}:${r.offset}`);
    const duplicates = identities.filter((id) => seen.includes(id));
    setSeen((previous) => [...new Set([...previous, ...identities])]);
    if (duplicates.length) setRedelivered(true);
    setState(next);
    log(
      next.lastRead.length
        ? `${group}: прочитано ${next.lastRead.length}. ${duplicates.length ? `Повторная доставка: ${duplicates.length}. ` : ''}Offset ещё не подтверждён.`
        : `${group}: новых событий на текущей позиции нет.`,
    );
  }
  function reset() {
    setState(initialState());
    setSeen([]);
    setRestarted(false);
    setRedelivered(false);
    setSelected(null);
    setJournal([]);
    setMessage('Новый эксперимент. Все учебные события удалены.');
  }
  const challenge = [
    state.partitions.flat().length >= 3,
    restarted && redelivered,
    lag(state, 'billing') === 0 && state.partitions.flat().length >= 3,
  ];
  return (
    <>
      <div className="page-heading with-action">
        <div>
          <h1>Песочница событий</h1>
          <p>Отправьте событие и проследите его путь. Здесь можно ошибаться и начинать заново.</p>
        </div>
        <button className="outline" onClick={reset}>
          <RotateCcw size={16} />
          Заново
        </button>
      </div>
      <div className="model-notice">
        <Info size={18} />
        <span>
          <strong>Учебная модель.</strong> Без подключения к брокеру. Настоящий Kafka доступен в
          лаборатории.
        </span>
        <a href="#sources">Границы модели</a>
      </div>
      <div className="sandbox-controls">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="producer-form"
        >
          <div className="section-index">Producer / Запись</div>
          <div className="input-row">
            <label>
              Ключ события
              <input value={key} maxLength={64} onChange={(e) => setKey(e.target.value)} required />
            </label>
            <label>
              Значение
              <input
                value={value}
                maxLength={500}
                onChange={(e) => setValue(e.target.value)}
                required
              />
            </label>
            <button type="submit" className="primary">
              <Send size={17} />
              Отправить
            </button>
          </div>
          <p>Одинаковый ключ попадает в одну партицию при неизменном их количестве.</p>
        </form>
        <div className="consumer-form">
          <div className="section-index">Consumer group / Чтение</div>
          <div className="input-row">
            <label>
              Группа
              <select
                aria-label="Группа"
                value={group}
                onChange={(e) => {
                  setGroup(e.target.value as GroupId);
                  setState((s) => ({ ...s, lastRead: [] }));
                }}
              >
                <option value="billing">billing</option>
                <option value="analytics">analytics</option>
              </select>
            </label>
            <label>
              Потребителей
              <select
                aria-label="Потребителей"
                value={consumers}
                onChange={(e) => {
                  setConsumers(Number(e.target.value));
                  log('Назначения изменены. В модели ребалансировка мгновенная.');
                }}
              >
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>
      <section className="log-canvas">
        <div className="canvas-heading">
          <h2>
            orders<span>3 партиции</span>
          </h2>
          <div className="lag">
            <span>Committed lag</span>
            <strong data-testid="lag">{lag(state, group)}</strong>
            <span>событий</span>
          </div>
        </div>
        <div className="partition-header">
          <span>Партиция / журнал событий</span>
          <span>Позиция / commit</span>
          <span>Владелец</span>
        </div>
        {state.partitions.map((records, p) => (
          <div className="partition-row" key={p}>
            <div className="partition-log">
              <code>p{p}</code>
              <div className="records">
                {records.length ? (
                  records.map((r) => (
                    <button
                      aria-label={`Партиция ${p}, offset ${r.offset}, ключ ${r.key}`}
                      title={`${r.key}: ${r.value}`}
                      key={r.offset}
                      onClick={() => setSelected({ partition: p, offset: r.offset })}
                      className={`record ${r.offset < current.committed[p] ? 'committed' : r.offset < current.position[p] ? 'read' : ''}`}
                    >
                      {r.offset}
                    </button>
                  ))
                ) : (
                  <span className="empty-log">Событий пока нет</span>
                )}
              </div>
              <ArrowRight size={17} />
            </div>
            <div className="offset-pair">
              <span title="Следующий offset для чтения">{current.position[p]}</span>
              <span>/</span>
              <strong title="Сохранённый следующий offset">{current.committed[p]}</strong>
            </div>
            <span className="owner">consumer-{assignments[p] + 1}</span>
          </div>
        ))}
        <div className="log-legend">
          <span>
            <i />
            Не прочитано
          </span>
          <span>
            <i className="read" />
            Прочитано
          </span>
          <span>
            <i className="committed" />
            Подтверждено
          </span>
          {consumers > 3 && <strong>{consumers - 3} потребителя без партиций</strong>}
        </div>
      </section>
      <div className="consumer-actions">
        <button className="primary" onClick={read}>
          <Play size={16} />
          Прочитать пакет
        </button>
        <button
          className="outline"
          onClick={() => {
            setState((s) => commit(s, group));
            log(
              `${group}: сохранён следующий offset для каждой партиции. События остаются в журнале.`,
            );
          }}
        >
          <Check size={17} />
          Подтвердить offset
        </button>
        <button
          className="outline"
          onClick={() => {
            setState((s) => restart(s, group));
            setRestarted(true);
            log(`${group}: перезапуск. Чтение продолжится с сохранённого offset.`);
          }}
        >
          <RotateCcw size={17} />
          Перезапустить consumer
        </button>
      </div>
      <p className="sandbox-status" role="status">
        {message}
      </p>
      <div className="sandbox-bottom">
        <section className="experiment">
          <div className="section-index">Эксперимент / Повторная доставка</div>
          <h2>Почему событие пришло дважды?</h2>
          <p>
            Запишите три события. Прочитайте пакет, затем перезапустите consumer до подтверждения.
            Прочитайте снова и завершите обработку группы billing.
          </p>
          <ol>
            {[
              'Отправьте минимум 3 события',
              'Получите повтор после перезапуска без commit',
              'Прочитайте оставшееся и подтвердите offset billing',
            ].map((text, i) => (
              <li key={text} className={challenge[i] ? 'done' : ''}>
                <span>{challenge[i] ? <Check size={14} /> : i + 1}</span>
                {text}
              </li>
            ))}
          </ol>
          {challenge.every(Boolean) && (
            <div className="feedback success">
              <strong>Эксперимент выполнен</strong>
              <p>
                Повторная доставка требует идемпотентной обработки. Commit после обработки снижает
                риск потери, но сам по себе не исключает дубликаты.
              </p>
            </div>
          )}
        </section>
        <section className="inspector">
          <h2>{event ? 'Событие в журнале' : 'Журнал эксперимента'}</h2>
          {event ? (
            <>
              <pre>{JSON.stringify(event, null, 2)}</pre>
              <button className="text" onClick={() => setSelected(null)}>
                Вернуться к журналу
              </button>
            </>
          ) : journal.length ? (
            <ol>
              {journal.map((entry, i) => (
                <li key={`${i}-${entry}`}>{entry}</li>
              ))}
            </ol>
          ) : (
            <p>
              Здесь появятся результаты действий. Нажмите на событие, чтобы увидеть ключ, значение и
              offset.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
