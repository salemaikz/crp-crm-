// Боевые зависимости прогона: БД, блокировки, лицензия, systemActor. Общие для воркера и `crmctl job run`.
import { currentLicenseState } from '@/server/access/license';
import { systemActor } from '@/server/access/systemActor';
import { LOCKING_LICENSE_STATES } from '@/server/access/types';
import { getDb } from '@/server/platform/db';
import { tryAdvisoryLock } from '@/server/platform/db/locks';
import { claim, finish, JOB_LOCK_CLASS, type JobLogger, type RunnerDeps } from '@/server/platform/jobs';

/** Журнал контейнера: одна JSON-строка, только коды и числа (ПДн сюда не попадают). */
export const consoleJobLogger: JobLogger = {
  info: (code, data) => console.log(JSON.stringify({ level: 'info', code, ...data })),
  warn: (code, data) => console.warn(JSON.stringify({ level: 'warn', code, ...data })),
};

export function makeRunnerDeps(log: JobLogger = consoleJobLogger): RunnerDeps {
  return {
    lock: async (runName) => tryAdvisoryLock(await getDb(), JOB_LOCK_CLASS, runName),
    claim: async (runName, slotKey, now, max) => claim(await getDb(), runName, slotKey, now, max),
    finish: async (runId, status, stats, error, now) => finish(await getDb(), runId, status, stats, error, now),
    businessBlocked: async () => LOCKING_LICENSE_STATES.has(await currentLicenseState()),
    // systemActor не принимает «@» в имени: `distribute@sales` → `distribute:sales`
    actorFor: (runName, now) => systemActor(runName.replace('@', ':'), now),
    log,
    clock: () => Date.now(),
    exit: (code) => process.exit(code),
  };
}
