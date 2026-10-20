// Задачи платформы (дизайн worker-design §6–7): events-ensure, invariants, purge, заглушки license и config-integrity.
// Модули подключают свои части в массивы invariantParts и purgeParts (registry.ts собирает их одной строкой).
import type { SystemActor } from '@/server/access';
import { bookingDeps, ensureAllSeries } from '@/server/domain/booking';
import { getDb } from '@/server/platform/db';
import { purgeInvites, purgePushOutbox, purgeSessions, type JobDefinition, type JobResult, type Ms } from '@/server/platform/jobs';

/** Часть сверки `invariants`: возвращает число найденных нарушений (в stats по ключу части). */
export interface InvariantPart {
  key: string;
  run(actor: SystemActor, signal: AbortSignal): Promise<number>;
}

/** Часть чистки `purge`: возвращает число удалённых строк. `now` — момент прогона (пороги считает часть). */
export interface PurgePart {
  key: string;
  run(actor: SystemActor, now: Ms, signal: AbortSignal): Promise<number>;
}

export const platformPurgeParts: readonly PurgePart[] = [
  { key: 'sessions', run: async (_a, now, signal) => purgeSessions(await getDb(), now, signal) },
  { key: 'invites', run: async (_a, now, signal) => purgeInvites(await getDb(), now, signal) },
  { key: 'push_outbox', run: async (_a, now, signal) => purgePushOutbox(await getDb(), now, signal) },
];

/** Общий прогон частей: сбой одной не останавливает остальные; хоть один сбой → ошибка прогона (повтор по слоту). */
async function runParts<P extends { key: string }>(
  parts: readonly P[],
  call: (p: P) => Promise<number>,
  signal: AbortSignal,
  log: (code: string, key: string) => void,
): Promise<{ stats: Record<string, number>; failed: string[] }> {
  const stats: Record<string, number> = {};
  const failed: string[] = [];
  for (const p of parts) {
    if (signal.aborted) break;
    try {
      stats[p.key] = await call(p);
    } catch {
      failed.push(p.key);
      log('part_failed', p.key);
    }
  }
  return { stats, failed };
}

export function makeInvariantsJob(parts: readonly InvariantPart[]): JobDefinition {
  return {
    name: 'invariants',
    perSpace: false,
    schedule: () => ({ kind: 'daily', at: '02:40', days: 'all' }),
    writes: 'housekeeping',
    handler: async (ctx): Promise<JobResult> => {
      const { stats, failed } = await runParts(parts, (p) => p.run(ctx.actor, ctx.signal), ctx.signal, (c, k) => ctx.log.warn(c, { part: k }));
      if (failed.length > 0) throw Object.assign(new Error('invariants'), { code: 'parts_failed' });
      return { status: 'ok', stats };
    },
  };
}

export function makePurgeJob(parts: readonly PurgePart[]): JobDefinition {
  return {
    name: 'purge',
    perSpace: false,
    schedule: () => ({ kind: 'daily', at: '03:30', days: 'all' }),
    writes: 'housekeeping',
    handler: async (ctx): Promise<JobResult> => {
      const { stats, failed } = await runParts(parts, (p) => p.run(ctx.actor, ctx.now, ctx.signal), ctx.signal, (c, k) => ctx.log.warn(c, { part: k }));
      if (failed.length > 0) throw Object.assign(new Error('purge'), { code: 'parts_failed' });
      return { status: 'ok', stats };
    },
  };
}

/** Серии мероприятий: догенерация горизонта (ARCHITECTURE §6.2; 00:30, а не 03:00 из booking-design). */
export const eventsEnsureJob: JobDefinition = {
  name: 'events-ensure',
  perSpace: false,
  schedule: () => ({ kind: 'daily', at: '00:30', days: 'all' }),
  writes: 'business',
  handler: async (ctx): Promise<JobResult> => {
    const reports = await ensureAllSeries(bookingDeps(), ctx.actor);
    const sum = (f: (r: (typeof reports)[number]) => number) => reports.reduce((a, r) => a + f(r), 0);
    return { status: 'ok', stats: { series: reports.length, created: sum((r) => r.created), updated: sum((r) => r.updated), retired: sum((r) => r.retired) } };
  },
};

const notImplemented = async (): Promise<JobResult> => ({ status: 'skipped', stats: {}, note: 'not_implemented' });

/** Заглушка до P10: страница «Состояние» показывает «не реализовано». */
export const licenseJob: JobDefinition = {
  name: 'license',
  perSpace: false,
  schedule: () => ({ kind: 'interval', everyMin: 60 }),
  runOnStart: true,
  writes: 'housekeeping',
  handler: notImplemented,
};

export const configIntegrityJob: JobDefinition = {
  name: 'config-integrity',
  perSpace: false,
  schedule: () => ({ kind: 'daily', at: '02:45', days: 'all' }),
  writes: 'housekeeping',
  handler: notImplemented,
};
