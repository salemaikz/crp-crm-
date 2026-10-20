// SystemActor — фоновые задачи и CLI (ARCHITECTURE §2.2). Импорт этого файла разрешён только
// scripts/** и src/server/jobs/** (ESLint, tests/unit/layers.test.ts); домен берёт только тип.
import type { SystemActor } from './types';
import { registerActor } from './registry';

export type { SystemActor };

/** Создать исполнителя-систему. `job` — имя задачи или команды (`purge`, `distribute@sales`), попадает в аудит. */
export function systemActor(job: string, now: number = Date.now()): SystemActor {
  if (!/^[a-z][a-z0-9_.:@-]{0,63}$/.test(job)) throw new Error('systemActor: имя задачи — латиница, цифры, «._:@-» (экземпляр задачи — `distribute@sales`)');
  return registerActor(Object.freeze({ kind: 'system' as const, job, now }));
}
