// Реестр задач и очередей воркера (дизайн worker-design §6). Новая задача модуля — одна строка в jobDefinitions
// (после влития модуля: distributeJob, части invariants и purge — см. §9 дизайна).
import type { ActiveConfig } from '@crm/core/config';
import type { JobDefinition, JobInstance, QueueSpec } from '@/server/platform/jobs';
import { isFeatureEnabled } from '@/server/platform/flags';
import {
  configIntegrityJob,
  eventsEnsureJob,
  licenseJob,
  makeInvariantsJob,
  makePurgeJob,
  platformPurgeParts,
  type InvariantPart,
  type PurgePart,
} from './platform';

/** Части сверки `invariants`: сюда модули добавляют свои (C5 countOwnerlessWorkingCards, B4b). */
export const invariantParts: InvariantPart[] = [];
/** Части чистки `purge`: платформа + модули (device_status — C5, import_rows/ingest_batches — base). */
export const purgeParts: PurgePart[] = [...platformPurgeParts];

export function jobDefinitions(): JobDefinition[] {
  return [eventsEnsureJob, makeInvariantsJob(invariantParts), makePurgeJob(purgeParts), licenseJob, configIntegrityJob];
}

/** Очереди: обработчики появятся с плагинами (O6) и push (P8b); без обработчика строки уходят в retry no_handler. */
export function queueSpecs(): QueueSpec[] {
  return [
    {
      name: 'webhook_inbox',
      batch: 20,
      leaseMs: 60_000,
      maxAttempts: 8,
      handlers: new Map(),
      enabled: () => true,
      writes: 'business',
    },
    {
      name: 'push_outbox',
      batch: 20,
      leaseMs: 60_000,
      maxAttempts: 5,
      handlers: new Map(),
      enabled: () => isFeatureEnabled('PUSH'),
      writes: 'business',
    },
  ];
}

/** Экземпляры задач на активных настройках: `perSpace` — по одному на пространство. */
export function instancesFor(defs: readonly JobDefinition[], cfg: ActiveConfig): JobInstance[] {
  const out: JobInstance[] = [];
  for (const def of defs) {
    if (!def.perSpace) {
      out.push({ def, runName: def.name, space: null, spec: def.schedule({ global: cfg.global.doc, space: null }) });
      continue;
    }
    for (const [key, s] of Object.entries(cfg.spaces)) {
      out.push({
        def,
        runName: `${def.name}@${key}`,
        space: { id: s.spaceId, key },
        spec: def.schedule({ global: cfg.global.doc, space: s.doc }),
      });
    }
  }
  return out;
}
