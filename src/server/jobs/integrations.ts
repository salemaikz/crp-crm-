// Обработчики очереди webhook_inbox (дизайн §7.7): ключ — pluginId строки integrations. Обработчик читает строку,
// разбирает payload чистым parse() плагина и отдаёт нормализованные события применителю своего вида плагина
// (messenger — applyMessengerEvents, O7a). Нет применителя — нет обработчика: строка ждёт в retry no_handler.
// Строка, которая уходит в failed — сразу (`invalid_settings`, разбор) или после последней попытки, — поднимает
// уведомление администраторам `integration_inbox_failed` (D-298, не чаще раза в сутки на подключение).
import type { NormalizedEvent, PluginId, PluginKind, PluginRegistry, InboxItem } from '@/integrations/contract';
import { pluginDeps, registry as defaultRegistry } from '@/integrations/registry';
import type { SystemActor } from '@/server/access';
import { loadInboxItem, notifyInboxFailed } from '@/server/domain/integrations';
import { applyMessengerEvents } from '@/server/domain/messenger';
import type { QueueHandler, QueueOutcome } from '@/server/platform/jobs';

export type InboxApplier = (
  actor: SystemActor,
  input: { integrationId: string; pluginId: PluginId; kind: InboxItem['kind']; events: NormalizedEvent[]; attempt: number },
) => Promise<QueueOutcome>;

/** Попыток на строку webhook_inbox (queueSpecs); после последней строка уходит в failed. */
export const WEBHOOK_MAX_ATTEMPTS = 8;

const KINDS: ReadonlySet<string> = new Set<InboxItem['kind']>(['message', 'status', 'channel', 'call']);

/** Применители по видам плагинов: мессенджер — события в чаты, ленту и задачи (O7a); телефония — O7b. */
export const defaultAppliers: Partial<Record<PluginKind, InboxApplier>> = {
  messenger: (actor, input) => applyMessengerEvents(actor, pluginDeps(), input),
};

export type InboxFailedNotifier = (actor: SystemActor, a: { integrationId: string; now: number }) => Promise<void>;

/** Станет ли строка failed с этим исходом (как settle очереди): failed — сразу, повтор и исключение — на последней попытке. */
function becomesFailed(outcome: QueueOutcome | null, attempt: number, maxAttempts: number): boolean {
  if (outcome?.status === 'done') return false;
  return outcome?.status === 'failed' || attempt >= maxAttempts;
}

export function webhookHandlers(
  registry: PluginRegistry = defaultRegistry,
  appliers: Partial<Record<PluginKind, InboxApplier>> = defaultAppliers,
  opts: { maxAttempts?: number; notifyFailed?: InboxFailedNotifier } = {},
): Map<string, QueueHandler> {
  const out = new Map<string, QueueHandler>();
  const maxAttempts = opts.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS;
  const notify = opts.notifyFailed ?? notifyInboxFailed;
  for (const plugin of registry.all()) {
    const hook = plugin.webhook;
    const apply = appliers[plugin.kind];
    if (!hook || !apply) continue;
    const handle = async (actor: SystemActor, item: { id: string; attempt: number }, seen: (integrationId: string) => void): Promise<QueueOutcome> => {
      const row = await loadInboxItem(actor, item.id);
      if (!row) return { status: 'failed', error: 'missing' };
      seen(row.integrationId);
      if (row.payload === null || row.payload === undefined) return { status: 'failed', error: 'payload_purged' };
      if (!KINDS.has(row.kind)) return { status: 'failed', error: 'unknown_kind' };
      const kind = row.kind as InboxItem['kind'];
      let events: NormalizedEvent[];
      try {
        events = hook.parse(kind, row.payload);
      } catch {
        return { status: 'failed', error: 'parse_failed' };
      }
      if (events.length === 0) return { status: 'done' };
      return apply(actor, { integrationId: row.integrationId, pluginId: plugin.id, kind, events, attempt: item.attempt });
    };

    out.set(plugin.id, async (actor, item) => {
      let integrationId: string | null = null;
      let outcome: QueueOutcome | null = null;
      try {
        outcome = await handle(actor, item, (id) => (integrationId = id));
        return outcome;
      } finally {
        // Исключение обработчика очередь считает повтором: на последней попытке это тоже failed
        if (integrationId && becomesFailed(outcome, item.attempt, maxAttempts)) {
          await notify(actor, { integrationId, now: actor.now }).catch(() => undefined);
        }
      }
    });
  }
  return out;
}
