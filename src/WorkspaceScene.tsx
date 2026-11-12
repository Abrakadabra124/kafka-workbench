import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Box, Pause, Play, RotateCcw, Server, Radio, ArrowRight } from 'lucide-react';
import { useSceneMotion } from './useSceneMotion';
import type { ClusterSnapshot } from './workspace-types';

export function WorkspaceScene({
  snapshot,
  replaying,
  playing,
  action,
  eventId,
  onPlaying,
  onEligible,
}: {
  snapshot: ClusterSnapshot | null;
  replaying: boolean;
  playing: boolean;
  action?: string;
  eventId?: string;
  onPlaying: (value: boolean) => void;
  onEligible: (value: boolean) => void;
}) {
  const motion = useSceneMotion();
  const [flat, setFlat] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const running = playing && replaying && motion.eligible;
  useEffect(() => onEligible(motion.eligible), [motion.eligible, onEligible]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = () => {
      const scale = Math.min(0.94, element.clientWidth / 980);
      element.style.setProperty('--cluster-scale', String(scale));
      element.style.height = `${Math.round(330 * scale + 28)}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(element);
    return () => ro.disconnect();
  }, []);
  const lag = snapshot?.partitions.reduce((n, p) => n + p.lag, 0);
  return (
    <section
      ref={motion.ref}
      className={`cluster-scene ${flat ? 'is-flat' : ''}`}
      data-motion={
        motion.reduced
          ? 'reduced'
          : !motion.visible
            ? 'hidden'
            : !motion.inView
              ? 'offscreen'
              : running
                ? 'running'
                : 'paused'
      }
      aria-label="Топология реального стенда"
    >
      <div className="cluster-toolbar">
        <div>
          <span className="eyebrow">{replaying ? 'ЗАПИСЬ ЗАПУСКА' : 'ПОСЛЕДНИЙ СНИМОК KAFKA'}</span>
          <h2>Три брокера. Один поток.</h2>
        </div>
        <div className="cluster-controls">
          <button
            className="outline"
            onClick={() => onPlaying(!playing)}
            disabled={!replaying || motion.reduced}
            aria-label={playing ? 'Приостановить запись' : 'Воспроизвести запись'}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button
            className="outline"
            onClick={() => setFlat(!flat)}
            aria-pressed={flat}
            aria-label="Плоский вид топологии"
          >
            <Box size={16} />
            {flat ? 'Плоский' : '3D'}
          </button>
        </div>
      </div>
      <div className="cluster-caption">
        {snapshot
          ? `${snapshot.topic} · ${new Date(snapshot.capturedAt).toLocaleTimeString('ru-RU')} · метрики из Kafka`
          : 'Подготовьте стенд. Состояние брокеров пока не измерено.'}
      </div>
      <div className="cluster-viewport" ref={viewport} aria-hidden="true">
        <div className="cluster-world">
          <div className="cluster-plinth" />
          <div className="cluster-architecture-grid" />
          <svg className="cluster-wires" viewBox="0 0 850 330">
            <path d="M80 165 H180 M180 165 H420 M420 165 H660 M660 165 H780" />
            <path d="M220 250 C340 302 510 302 630 250" />
          </svg>
          <div className="cluster-endpoint cluster-producer">
            <Radio size={26} />
            <strong>Producer</strong>
            <small>acks=all</small>
          </div>
          {[1, 2, 3].map((id) => {
            const broker = snapshot?.brokers.find((b) => b.id === id);
            return (
              <div
                className={`cluster-rack ${broker && !broker.running ? 'is-down' : ''}`}
                style={
                  {
                    '--rack-x': `${145 + (id - 1) * 213}px`,
                    '--rack-z': `${id === 2 ? 24 : 0}px`,
                  } as CSSProperties
                }
                key={id}
              >
                <div className="rack-top" />
                <div className="rack-side" />
                <div className="rack-front">
                  <div className="rack-heading">
                    <Server size={16} />
                    <strong>broker {id}</strong>
                    <span className={broker?.running ? 'rack-light online' : 'rack-light'} />
                  </div>
                  {[0, 1, 2].map((p) => {
                    const row = snapshot?.partitions.find((r) => r.partition === p);
                    const leader = row?.leader === id;
                    const synced = row?.isr.includes(id);
                    return (
                      <div
                        key={p}
                        className={`replica-slot ${leader ? 'is-leader' : ''} ${row && !synced ? 'not-synced' : ''}`}
                      >
                        <span>p{p}</span>
                        <div className="replica-cells">
                          {row && !synced ? (
                            <em className="replica-unmeasured">?</em>
                          ) : (
                            Array.from({ length: Math.min(row?.end ?? 0, 5) }, (_, n) => (
                              <i key={n} />
                            ))
                          )}
                        </div>
                        <b>{row ? (leader ? 'L' : synced ? 'R' : '!') : '?'}</b>
                      </div>
                    );
                  })}
                  <div className="rack-foot">
                    <span>{broker ? (broker.running ? 'ONLINE' : 'STOPPED') : 'НЕ ИЗМЕРЕНО'}</span>
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              </div>
            );
          })}
          <div className="cluster-endpoint cluster-consumer">
            <RotateCcw size={26} />
            <strong>orders</strong>
            <small>{lag === undefined ? 'lag ?' : `lag ${lag}`}</small>
          </div>
          {replaying && ['produce', 'consume'].includes(action ?? '') && (
            <div className={`cluster-packet packet-${action}`} key={eventId}>
              <ArrowRight size={12} />
            </div>
          )}
        </div>
      </div>
      <div className="cluster-legend">
        <span>
          <b>L</b> Лидер партиции
        </span>
        <span>
          <b>R</b> Синхронная реплика
        </span>
        <span>
          <b>!</b> Вне ISR
        </span>
        <span>Движение воспроизводит сохранённый шаг</span>
        <span>? Заполнение реплики вне ISR не измерено</span>
      </div>
      <p className="cluster-access-note">
        Producer (acks=all) → broker 1 / 2 / 3 → группа orders. Таблица показывает состояние orders,
        даже если в рецепте выбрана audit. Ячейки иллюстрируют общий журнал партиции; отдельные
        позиции реплик не измеряются.
      </p>
      {motion.reduced && (
        <p className="cluster-access-note">
          Движение отключено настройкой системы. Используйте шаги истории и таблицу.
        </p>
      )}
      {snapshot && (
        <div
          className="cluster-table-wrap"
          tabIndex={0}
          role="region"
          aria-label="Таблица состояния Kafka"
        >
          <table className="cluster-table">
            <caption>Фактические offsets и реплики группы orders</caption>
            <thead>
              <tr>
                <th>Partition</th>
                <th>Leader</th>
                <th>ISR / реплики</th>
                <th>End</th>
                <th>Commit</th>
                <th>Lag</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.partitions.map((p) => (
                <tr key={p.partition}>
                  <th>p{p.partition}</th>
                  <td>broker {p.leader}</td>
                  <td>
                    {p.isr.join(', ')} / {p.replicas.length}
                  </td>
                  <td>{p.end}</td>
                  <td>{p.committed ?? 'нет'}</td>
                  <td>{p.lag}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
