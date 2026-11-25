import { useState } from 'react';
import { BasicLab } from './BasicLab';
import { Workspace } from './Workspace';
export function Lab({ initialTask }: { initialTask?: string }) {
  const [basic, setBasic] = useState(initialTask === 'basic');
  return (
    <>
      <div className="workspace-tabs" aria-label="Режим лаборатории">
        <button
          className={!basic ? 'primary' : 'outline'}
          aria-pressed={!basic}
          onClick={() => {
            setBasic(false);
            window.history.replaceState(null, '', '#lab');
          }}
        >
          Практикум: 3 брокера
        </button>
        <button
          className={basic ? 'primary' : 'outline'}
          aria-pressed={basic}
          onClick={() => {
            setBasic(true);
            window.history.replaceState(null, '', '#lab/basic');
          }}
        >
          Базовая лаборатория
        </button>
      </div>
      {basic ? <BasicLab /> : <Workspace initialTask={initialTask} />}
    </>
  );
}
