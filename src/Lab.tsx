import { useState } from 'react';
import { BasicLab } from './BasicLab';
import { Workspace } from './Workspace';
export function Lab() {
  const [basic, setBasic] = useState(false);
  return (
    <>
      <div className="workspace-tabs" aria-label="Режим лаборатории">
        <button
          className={!basic ? 'primary' : 'outline'}
          aria-pressed={!basic}
          onClick={() => setBasic(false)}
        >
          Практикум: 3 брокера
        </button>
        <button
          className={basic ? 'primary' : 'outline'}
          aria-pressed={basic}
          onClick={() => setBasic(true)}
        >
          Базовая лаборатория
        </button>
      </div>
      {basic ? <BasicLab /> : <Workspace />}
    </>
  );
}
