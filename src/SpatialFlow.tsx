import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Box, Check, Code2, Layers3, Pause, Play, TriangleAlert } from 'lucide-react';
import { useSceneMotion } from './useSceneMotion';
import './spatial-flow.css';

export type FlowActivity = {
  id: number;
  type: 'produce' | 'read' | 'commit' | 'restart';
  partition?: number;
  partitions?: number[];
};
type NodeStatus = 'healthy' | 'degraded' | 'blocked';
type Partition = { count: number; position: number; committed: number; owner: number };
type SpatialFlowProps = {
  mode: 'overview' | 'sandbox' | 'incident';
  nodes?: Record<'producer' | 'broker' | 'consumer' | 'external', NodeStatus>;
  partitions?: Partition[];
  activity?: FlowActivity;
  lag?: number;
  duplicates?: number;
  isr?: number;
  inRate?: number;
  outRate?: number;
  playing?: boolean;
  playbackDisabled?: boolean;
  onPlayingChange?: (playing: boolean) => void;
  onActiveChange?: (active: boolean) => void;
};
const labels: Record<NodeStatus, string> = {
  healthy: 'Работает',
  degraded: 'Есть проблема',
  blocked: 'Заблокирован',
};
const healthyNodes = {
  producer: 'healthy',
  broker: 'healthy',
  consumer: 'healthy',
  external: 'healthy',
} as const;
const demonstration = Array.from({ length: 3 }, (_, p) => ({
  count: 5 - p,
  position: 2,
  committed: 1,
  owner: p % 2,
}));
const number = new Intl.NumberFormat('ru-RU');

function Cuboid({
  className = '',
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <div className={`sf-cuboid ${className}`} style={style}>
      <div className="sf-face sf-top" />
      <div className="sf-face sf-right" />
      <div className="sf-face sf-left" />
      <div className="sf-face sf-bottom" />
      <div className="sf-face sf-front">{children}</div>
    </div>
  );
}

function Status({ value }: { value: NodeStatus }) {
  return (
    <span className={`sf-node-status sf-status-${value}`}>
      {value === 'healthy' ? <Check size={11} /> : <TriangleAlert size={11} />}
      {labels[value]}
    </span>
  );
}

export function SpatialFlow({
  mode,
  nodes = healthyNodes,
  partitions,
  activity,
  lag = 0,
  duplicates = 0,
  isr = 3,
  inRate = 1,
  outRate = 1,
  playing,
  playbackDisabled = false,
  onPlayingChange,
  onActiveChange,
}: SpatialFlowProps) {
  const scene = useSceneMotion();
  const captionId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const [localPlaying, setLocalPlaying] = useState(true);
  const [view, setView] = useState<'spatial' | 'flat'>('spatial');
  const [finishedActivity, setFinishedActivity] = useState<number>();
  const activityClock = useRef({ id: activity?.id, remaining: 2200 });
  const requestedPlaying = playing ?? localPlaying;
  const activeActivity = activity && activity.id !== finishedActivity;
  const hasAction =
    mode !== 'sandbox' ||
    Boolean(
      activeActivity && (activity.partitions?.length ?? (activity.partition === undefined ? 0 : 1)),
    );
  const running = scene.eligible && requestedPlaying && hasAction;
  const motionState = scene.reduced
    ? 'reduced'
    : !scene.visible
      ? 'hidden'
      : !scene.inView
        ? 'offscreen'
        : !requestedPlaying
          ? 'paused'
          : !hasAction
            ? 'idle'
            : 'running';
  const data = partitions ?? demonstration;
  const affected =
    activity?.partitions ?? (activity?.partition === undefined ? [] : [activity.partition]);

  useEffect(() => {
    onActiveChange?.(scene.eligible);
  }, [scene.eligible, onActiveChange]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const resize = () => {
      const scale = Math.min(
        mode === 'overview' ? 1.25 : 1,
        Math.max(0.2, (element.clientWidth - 12) / 690),
      );
      element.style.setProperty('--sf-scale', String(scale));
      element.style.height = `${Math.round(344 * scale + 14)}px`;
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode]);

  // One finite animation window per action; pausing preserves the remaining time.
  useEffect(() => {
    if (activityClock.current.id !== activity?.id)
      activityClock.current = { id: activity?.id, remaining: 2200 };
    if (mode !== 'sandbox' || !activity || !running) return;
    const clock = activityClock.current;
    const started = performance.now();
    const timer = window.setTimeout(() => {
      clock.remaining = 0;
      setFinishedActivity(activity.id);
    }, clock.remaining);
    return () => {
      clearTimeout(timer);
      clock.remaining = Math.max(0, clock.remaining - (performance.now() - started));
    };
  }, [activity?.id, mode, running]);

  function togglePlaying() {
    if (onPlayingChange) onPlayingChange(!requestedPlaying);
    else setLocalPlaying(!requestedPlaying);
  }
  function durationFor(edge: 'in' | 'out') {
    if (mode !== 'incident') return 2.2;
    const rate = edge === 'in' ? inRate : outRate;
    return Math.min(8, Math.max(1.4, 440 / Math.max(1, rate)));
  }
  function edgeFlow(edge: 'in' | 'out', p: number) {
    const blocked =
      edge === 'in'
        ? nodes.producer === 'blocked' || nodes.broker === 'blocked'
        : nodes.broker === 'blocked' || nodes.consumer === 'blocked';
    if (blocked) return 'blocked';
    if (mode === 'sandbox')
      return activeActivity &&
        affected.includes(p) &&
        activity?.type === (edge === 'in' ? 'produce' : 'read')
        ? 'active'
        : 'stopped';
    return (edge === 'in' ? inRate : outRate) > 0 ? 'active' : 'stopped';
  }

  return (
    <section
      ref={scene.ref}
      className="spatial-flow"
      data-mode={mode}
      data-motion-state={motionState}
      data-view={view}
      aria-label="Пространственная модель потока Kafka"
      aria-describedby={captionId}
    >
      <div className="sf-labels">
        <div>
          <strong>Producer</strong>
          {mode === 'incident' ? <Status value={nodes.producer} /> : <span>Запись событий</span>}
        </div>
        <div>
          <strong>Kafka</strong>
          <span>{mode === 'sandbox' ? 'orders · 3 партиции' : '3 партиции'}</span>
          {mode === 'incident' && <Status value={nodes.broker} />}
        </div>
        <div>
          <strong>Consumer</strong>
          {mode === 'incident' ? <Status value={nodes.consumer} /> : <span>Чтение журнала</span>}
        </div>
      </div>
      <div className="sf-viewport" ref={viewport} aria-hidden="true">
        <div className="sf-scale">
          <div className="sf-world">
            <div className="sf-floor-shadow" />
            <div className="sf-architecture-grid" />
            <div className="sf-backplane">
              <span>PARTITIONED EVENT LOG</span>
              <i />
              <i />
              <i />
            </div>
            <Cuboid className="sf-platform" />
            <div className="sf-manifold sf-manifold-in" />
            <div className="sf-manifold sf-manifold-out" />
            <Cuboid className={`sf-station sf-producer sf-node-${nodes.producer}`}>
              <div className="sf-terminal">
                <span>{'{…}'}</span>
                <i />
              </div>
              <div className="sf-station-foot">
                <i />
                <span />
              </div>
            </Cuboid>
            <Cuboid className={`sf-station sf-consumer sf-node-${nodes.consumer}`}>
              <div className="sf-terminal">
                <Code2 size={39} strokeWidth={1.5} />
                <i />
              </div>
              <div className="sf-station-foot">
                <i />
                <span />
              </div>
            </Cuboid>
            {data.slice(0, 3).map((partition, p) => {
              const highlighted = activeActivity && affected.includes(p);
              return (
                <div
                  className="sf-partition"
                  key={p}
                  data-partition={p}
                  data-count={partition.count}
                  data-position={partition.position}
                  data-committed={partition.committed}
                  data-owner={partition.owner}
                  data-action={highlighted ? activity?.type : 'none'}
                  style={{ '--sf-row': p } as CSSProperties}
                >
                  <Cuboid className={`sf-tray sf-node-${nodes.broker}`}>
                    <span className="sf-tray-id">p{p}</span>
                    <div className="sf-tray-window">
                      {Array.from({ length: Math.min(partition.count, 6) }, (_, index) => (
                        <Cuboid
                          key={index}
                          className={`sf-record ${mode === 'sandbox' && index < partition.committed ? 'sf-record-committed' : mode === 'sandbox' && index < partition.position ? 'sf-record-read' : ''}`}
                        />
                      ))}
                      {partition.count === 0 && (
                        <span className="sf-empty-slots">
                          <i />
                          <i />
                          <i />
                          <i />
                        </span>
                      )}
                    </div>
                    <div className="sf-leds">
                      {[1, 2, 3].map((replica) => (
                        <i key={replica} data-sync={replica <= isr} />
                      ))}
                    </div>
                  </Cuboid>
                  {(['in', 'out'] as const).map((edge) => (
                    <div
                      key={edge}
                      className={`sf-lane sf-lane-${edge}`}
                      data-edge={edge}
                      data-partition={p}
                      data-flow={edgeFlow(edge, p)}
                      style={{ '--sf-duration': `${durationFor(edge)}s` } as CSSProperties}
                    >
                      <div className="sf-rail" />
                      <div className="sf-rail-glow" />
                      {(mode === 'sandbox' ? [0] : [0, 1]).map((packet) => (
                        <div
                          key={`${activity?.id ?? 'loop'}-${packet}`}
                          className="sf-packet"
                          style={
                            {
                              '--sf-delay':
                                mode === 'sandbox'
                                  ? '0s'
                                  : `${packet * durationFor(edge) * -0.5 - p * 0.35}s`,
                            } as CSSProperties
                          }
                        >
                          <Cuboid className="sf-event" />
                        </div>
                      ))}
                      {edgeFlow(edge, p) === 'blocked' && <span className="sf-barrier">×</span>}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {mode === 'sandbox' && (
        <div className="sf-partition-data" aria-label="Состояние партиций">
          {data.slice(0, 3).map((partition, p) => (
            <div key={p}>
              <strong>
                p{p} <span>{partition.count} событий</span>
              </strong>
              <span>
                Позиция {partition.position} · commit {partition.committed}
              </span>
              <small>consumer-{partition.owner + 1}</small>
            </div>
          ))}
        </div>
      )}
      {mode === 'incident' && (
        <div className="sf-incident-data">
          <span>
            Lag <strong>{number.format(lag)}</strong>
          </span>
          <span>
            ISR <strong>{isr}/3</strong>
          </span>
          <span className={`sf-external sf-status-${nodes.external}`}>
            Внешняя система: {labels[nodes.external].toLocaleLowerCase('ru')}
          </span>
          {duplicates > 0 && (
            <span className="sf-damage">
              <TriangleAlert size={13} />
              Неурегулированные дубли: {number.format(duplicates)}
            </span>
          )}
        </div>
      )}
      <div className="sf-toolbar">
        <button
          type="button"
          onClick={togglePlaying}
          disabled={scene.reduced || playbackDisabled}
          title={
            playbackDisabled
              ? 'Сделайте первый шаг расследования, чтобы воспроизвести историю'
              : undefined
          }
          aria-label={requestedPlaying ? 'Приостановить движение' : 'Включить движение'}
          aria-pressed={requestedPlaying}
        >
          {requestedPlaying ? <Pause size={15} /> : <Play size={15} />}
          <span>{requestedPlaying ? 'Пауза' : 'Движение'}</span>
        </button>
        <button
          type="button"
          onClick={() => setView(view === 'spatial' ? 'flat' : 'spatial')}
          aria-label={view === 'spatial' ? 'Показать плоскую схему' : 'Показать объёмную сцену'}
          aria-pressed={view === 'flat'}
        >
          {view === 'spatial' ? <Box size={16} /> : <Layers3 size={16} />}
          <span>{view === 'spatial' ? '3D-ракурс' : 'Плоский вид'}</span>
        </button>
        <span className="sf-model-label">Учебная модель</span>
      </div>
      <p id={captionId} className="sf-caption">
        {scene.reduced
          ? 'Движение отключено настройкой системы. Все состояния доступны без анимации.'
          : mode === 'overview'
            ? 'События остаются в журнале после чтения.'
            : mode === 'sandbox'
              ? 'Сцена отражает ваши действия. Точные записи и offsets показаны в журнале ниже.'
              : 'Состояние выбранного кадра. Заблокированные участки не передают события. Скорость движения условная.'}
      </p>
    </section>
  );
}
