// Прогон одного экземпляра задачи (дизайн worker-design §3): блокировка → захват слота → таймаут → итог.
import type { time } from '@crm/core';
import type { SystemActor } from '@/server/access';
import type { HeldLock } from '../db/locks';
import { slotFor } from './slot';
import {
  JOB_DEFAULT_MAX_ATTEMPTS,
  JOB_DEFAULT_TIMEOUT_MS,
  JOB_HARD_KILL_GRACE_MS,
  type ClaimResult,
  type JobInstance,
  type JobLogger,
  type JobResult,
  type JobSpace,
  type Ms,
  type Slot,
} from './types';

/** Всё внешнее, что нужно прогону: в боевом воркере — БД и systemActor, в тестах — подделки. */
export interface RunnerDeps {
  /** Сессионная блокировка задачи; null — занята (идёт в другом процессе). */
  lock(runName: string): Promise<HeldLock | null>;
  claim(runName: string, slotKey: string, now: Ms, maxAttempts: number): Promise<ClaimResult>;
  finish(runId: string, status: 'ok' | 'failed' | 'skipped', stats: Readonly<Record<string, number>>, error: string, now: Ms): Promise<void>;
  /** true — лицензия не даёт писать бизнес-данные (read_only, invalid, missing). */
  businessBlocked(): Promise<boolean>;
  actorFor(runName: string, now: Ms): SystemActor;
  log: JobLogger;
  /** Часы процесса. */
  clock(): Ms;
  /** Выход процесса при зависшем обработчике (контейнер перезапустится). */
  exit(code: number): void;
  hardKillGraceMs?: number;
}

export type RunOutcome =
  | { kind: 'no_slot' }
  | { kind: 'locked' }
  | { kind: 'not_claimed'; reason: 'done' | 'backoff' }
  | { kind: 'ran'; status: 'ok' | 'skipped' | 'failed'; runId: string; attempt: number; error: string };

export interface RunInput {
  now: Ms;
  calendar: time.WorkCalendar;
  /** Явный слот (ручной запуск `manual:<uuid>`, запуск при старте `boot:<id>`); иначе слот по расписанию. */
  slot?: Slot;
  /** Общая остановка воркера. */
  signal?: AbortSignal;
}

/** Код ошибки без текста: тексты исключений могут нести ПДн. */
export function errorCode(e: unknown): string {
  const x = e as { code?: unknown; name?: unknown } | null;
  const raw = typeof x?.code === 'string' && x.code ? x.code : typeof x?.name === 'string' && x.name ? x.name : 'error';
  return raw.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64);
}

class TimeoutMark extends Error {
  override name = 'timeout';
}

export async function runInstance(deps: RunnerDeps, inst: JobInstance, input: RunInput): Promise<RunOutcome> {
  const { def, runName } = inst;
  let slot = input.slot ?? null;
  if (!slot) {
    if (!inst.spec) return { kind: 'no_slot' };
    slot = slotFor(inst.spec, input.now, input.calendar);
  }
  if (!slot) return { kind: 'no_slot' };

  const lock = await deps.lock(runName);
  if (!lock) return { kind: 'locked' };
  try {
    const maxAttempts = def.maxAttempts ?? JOB_DEFAULT_MAX_ATTEMPTS;
    const startedAt = deps.clock();
    const claimed = await deps.claim(runName, slot.key, startedAt, maxAttempts);
    if (claimed.kind !== 'claimed') return { kind: 'not_claimed', reason: claimed.kind };
    const { runId, attempt } = claimed;

    const done = async (status: 'ok' | 'failed' | 'skipped', stats: Readonly<Record<string, number>>, error: string): Promise<RunOutcome> => {
      await deps.finish(runId, status, stats, error, deps.clock());
      return { kind: 'ran', status, runId, attempt, error };
    };

    if (def.writes === 'business' && (await deps.businessBlocked())) return done('skipped', {}, 'license_read_only');

    const controller = new AbortController();
    const onStop = () => controller.abort();
    input.signal?.addEventListener('abort', onStop, { once: true });
    if (input.signal?.aborted) controller.abort();
    const space: JobSpace | null = inst.space;
    const actor = deps.actorFor(runName, startedAt);
    const timeoutMs = def.timeoutMs ?? JOB_DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work: Promise<JobResult> = Promise.resolve().then(() =>
        def.handler({ actor, runId, slot: slot as Slot, attempt, now: startedAt, signal: controller.signal, space, calendar: input.calendar, log: deps.log }),
      );
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          // Обработчик не вернулся за отведённое — процесс завершаем: Postgres откатит транзакции и снимет блокировку
          killTimer = setTimeout(() => deps.exit(70), deps.hardKillGraceMs ?? JOB_HARD_KILL_GRACE_MS);
          killTimer.unref?.();
          reject(new TimeoutMark('timeout'));
        }, timeoutMs);
      });
      // Позднее падение после таймаута не роняет процесс; вернувшийся обработчик отменяет «жёсткое» завершение
      work.then(() => {}, () => {}).finally(() => killTimer && clearTimeout(killTimer));
      const result = await Promise.race([work, timeout]);
      return await done(result.status, result.stats, result.note ?? '');
    } catch (e) {
      deps.log.warn('job_failed', { job: runName, attempt, code: errorCode(e) });
      return await done('failed', {}, errorCode(e));
    } finally {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener('abort', onStop);
    }
  } finally {
    await lock.release().catch(() => {});
  }
}
