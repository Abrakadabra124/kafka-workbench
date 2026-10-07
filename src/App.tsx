import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  ChartNoAxesColumnIncreasing,
  Check,
  CircleAlert,
  FlaskConical,
  House,
  Menu,
  Network,
  Terminal,
  X,
} from 'lucide-react';
import { api, go } from './api';
import { emptyProgress, type Module, type Progress } from './types';
import { Dashboard, Curriculum, ProgressPage, Sources } from './Pages';
import { LessonView } from './Lesson';
import { Sandbox } from './Sandbox';
import { Lab } from './Lab';
import { Incidents } from './Incidents';

const navigation = [
  { id: 'overview', title: 'Обзор', icon: House },
  { id: 'curriculum', title: 'Учебный маршрут', icon: BookOpen },
  { id: 'sandbox', title: 'Песочница', icon: Terminal },
  { id: 'incidents', title: 'Реальные проблемы', icon: CircleAlert },
  { id: 'lab', title: 'Лаборатория', icon: FlaskConical },
  { id: 'progress', title: 'Мой прогресс', icon: ChartNoAxesColumnIncreasing },
];
export default function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || 'overview');
  const [modules, setModules] = useState<Module[]>([]);
  const [progress, setProgress] = useState<Progress>(emptyProgress);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [mobile, setMobile] = useState(matchMedia('(max-width: 800px)').matches);
  const [menu, setMenu] = useState(false);
  const main = useRef<HTMLElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const previousRoute = useRef(route);
  const lessons = modules.flatMap((m) => m.lessons);
  const lesson = route.startsWith('lesson/')
    ? lessons.find((l) => l.id === route.slice(7))
    : undefined;
  const active = lesson ? 'curriculum' : route;
  const title = lesson?.title ?? navigation.find((n) => n.id === route)?.title ?? 'Источники';
  async function load() {
    setError('');
    try {
      const [course, saved] = await Promise.all([
        api<{ modules: Module[] }>('course'),
        api<Progress>('progress'),
      ]);
      setModules(course.modules);
      setProgress(saved);
      setReady(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const change = () => {
      setRoute(location.hash.slice(1) || 'overview');
      setMenu(false);
    };
    const media = matchMedia('(max-width: 800px)');
    const resize = () => {
      setMobile(media.matches);
      if (!media.matches) setMenu(false);
    };
    addEventListener('hashchange', change);
    media.addEventListener('change', resize);
    return () => {
      removeEventListener('hashchange', change);
      media.removeEventListener('change', resize);
    };
  }, []);
  useEffect(() => {
    document.title = `${title} - Kafka Workbench`;
    if (previousRoute.current !== route) {
      main.current?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
    previousRoute.current = route;
  }, [route, title]);
  useEffect(() => {
    if (menu && mobile) sidebar.current?.querySelector<HTMLButtonElement>('.close-menu')?.focus();
  }, [menu, mobile]);
  function closeMenu() {
    setMenu(false);
    requestAnimationFrame(() => toggle.current?.focus());
  }
  if (!ready)
    return (
      <main className="startup">
        <Network size={40} />
        <h1>Kafka Workbench</h1>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <p>Проверьте, запущен ли сервер приложения.</p>
            <button onClick={load}>Повторить подключение</button>
          </>
        ) : (
          <p role="status">Открываем рабочее пространство…</p>
        )}
      </main>
    );
  return (
    <div className="shell">
      <a
        className="skip"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        Перейти к содержимому
      </a>
      {menu && mobile && (
        <button
          className="backdrop"
          tabIndex={-1}
          aria-label="Закрыть навигацию"
          onClick={closeMenu}
        />
      )}
      <aside
        ref={sidebar}
        className={`sidebar ${menu ? 'is-open' : ''}`}
        inert={mobile && !menu}
        role={mobile && menu ? 'dialog' : undefined}
        aria-modal={(mobile && menu) || undefined}
        aria-label="Навигация"
        onKeyDown={(e) => {
          if (!mobile || !menu) return;
          if (e.key === 'Escape') closeMenu();
          if (e.key === 'Tab') {
            const items = sidebar.current!.querySelectorAll<HTMLElement>(
              'a[href],button:not([disabled])',
            );
            if (e.shiftKey && document.activeElement === items[0]) {
              e.preventDefault();
              items[items.length - 1].focus();
            } else if (!e.shiftKey && document.activeElement === items[items.length - 1]) {
              e.preventDefault();
              items[0].focus();
            }
          }
        }}
      >
        <a className="brand" href="#overview" onClick={() => setMenu(false)}>
          <Network size={37} strokeWidth={2} />
          <span>
            Kafka
            <br />
            Workbench
          </span>
        </a>
        <button className="close-menu icon-button" onClick={closeMenu} aria-label="Закрыть меню">
          <X />
        </button>
        <nav aria-label="Основные разделы">
          {navigation.map((n) => (
            <a
              key={n.id}
              href={`#${n.id}`}
              className={`nav-link ${active === n.id ? 'active' : ''}`}
              aria-current={active === n.id ? 'page' : undefined}
              onClick={() => setMenu(false)}
            >
              <n.icon size={21} strokeWidth={1.7} />
              {n.title}
            </a>
          ))}
        </nav>
        <div className="reference-nav">
          <span>Справочник</span>
          <a
            href="#sources"
            className={`nav-link ${route === 'sources' ? 'active' : ''}`}
            aria-current={route === 'sources' ? 'page' : undefined}
            onClick={() => setMenu(false)}
          >
            <BookOpen size={21} />
            Источники
          </a>
        </div>
        <a href="#progress" className="sidebar-progress" onClick={() => setMenu(false)}>
          <strong>Локальный прогресс</strong>
          <span>
            {progress.completed.length} / {lessons.length} уроков
          </span>
          <progress
            value={progress.completed.length}
            max={lessons.length}
            aria-label="Пройдено уроков"
          />
        </a>
      </aside>
      <div className="workspace" inert={mobile && menu}>
        <header className="topbar">
          <button
            ref={toggle}
            className="mobile-toggle icon-button"
            onClick={() => setMenu(true)}
            aria-label="Открыть меню"
            aria-expanded={menu}
          >
            <Menu />
          </button>
          <div className="breadcrumb">
            <span>Рабочее пространство</span>
            <span>/</span>
            <span>{title}</span>
          </div>
          <a className="button outline small" href="#sandbox">
            <Terminal size={17} />
            Открыть песочницу
          </a>
        </header>
        <main
          id="main"
          ref={main}
          tabIndex={-1}
          className={`main-content ${route === 'overview' ? 'overview' : ''}`}
        >
          {route === 'overview' ? (
            <Dashboard modules={modules} progress={progress} />
          ) : route === 'curriculum' ? (
            <Curriculum modules={modules} progress={progress} />
          ) : route === 'sandbox' ? (
            <Sandbox />
          ) : route === 'incidents' ? (
            <Incidents />
          ) : route === 'lab' ? (
            <Lab />
          ) : route === 'progress' ? (
            <ProgressPage modules={modules} progress={progress} onProgress={setProgress} />
          ) : route === 'sources' ? (
            <Sources modules={modules} />
          ) : lesson ? (
            <LessonView
              key={lesson.id}
              lesson={lesson}
              lessons={lessons}
              progress={progress}
              onProgress={setProgress}
            />
          ) : (
            <section>
              <h1>Страница не найдена</h1>
              <button onClick={() => go('overview')}>
                Вернуться к обзору
                <ArrowRight size={18} />
              </button>
            </section>
          )}
        </main>
        <footer>
          Прогресс сохраняется на этом компьютере
          <Check size={14} />
        </footer>
      </div>
    </div>
  );
}
