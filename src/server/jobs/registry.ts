// Реестр задач и очередей воркера (дизайн worker-design §6). Новая задача модуля — одна строка в jobDefinitions
// (distributeJob, части invariants и purge — по §9 дизайна).
import type { ActiveConfig } from '@crm/core/config';
import type { JobDefinition, JobInstance, QueueSpec } from '@/server/platform/jobs';
import { countOwnerlessWorkingCards } from '@/server/domain/cards';
import { attendanceSweepJob, countAgreedWithoutStep, greyAssignJob } from '@/server/domain/booking';
import { purgeDeviceStatus } from '@/server/domain/calls';
import { distributeJob } from '@/server/domain/distribution';
import { purgeExpiredImportRows } from '@/server/domain/import';
import { purgeWebhookPayloads } from '@/server/domain/integrations';
import { alarmsJob, digestJob } from '@/server/domain/notify';
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
import { WEBHOOK_MAX_ATTEMPTS, webhookHandlers } from './integrations';

const DAY_MS = 86_400_000;

/** Части сверки `invariants`: сюда модули добавляют свои . */
export const invariantParts: InvariantPart[] = [
  // рабочие карточки без владельца (D-066); число нарушений, без id
  { key: 'ownerless_cards', run: (actor) => countOwnerlessWorkingCards(actor) },
  // «Договорились» без записи и без задачи со сроком (D-049, D-244)
  { key: 'agreed_without_step', run: (actor) => countAgreedWithoutStep(actor) },
];
/** Части чистки `purge`: платформа + модули (ingest_batches — base, позже). */
export const purgeParts: PurgePart[] = [
  ...platformPurgeParts,
  // статус устройств: seen_at старше 30 дней (worker-design §7)
  { key: 'device_status', run: (actor, now) => purgeDeviceStatus(actor, now - 30 * DAY_MS) },
  // строки импорта по сроку import.rowsRetentionDays каждого пространства (C4d §11)
  { key: 'import_rows', run: async (actor, now) => (await purgeExpiredImportRows(actor, now)).deleted },
  // payload входящих вебхуков (ПДн): обнуляется через 14 дней, строки остаются (дизайн §7.7)
  { key: 'webhook_payload', run: (actor, now) => purgeWebhookPayloads(actor, now - 14 * DAY_MS) },
];

export function jobDefinitions(): JobDefinition[] {
  return [eventsEnsureJob, distributeJob, makeInvariantsJob(invariantParts), makePurgeJob(purgeParts), licenseJob, configIntegrityJob, digestJob, alarmsJob, greyAssignJob, attendanceSweepJob];
}

/** Очереди: вебхуки — обработчики по pluginId (O6, применители — O7a), push — P8b; без обработчика — retry no_handler. */
export function queueSpecs(): QueueSpec[] {
  return [
    {
      name: 'webhook_inbox',
      batch: 20,
      leaseMs: 60_000,
      maxAttempts: WEBHOOK_MAX_ATTEMPTS,
      handlers: webhookHandlers(),
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
