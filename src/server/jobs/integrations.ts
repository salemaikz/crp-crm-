// Обработчики очереди webhook_inbox (дизайн §7.7): ключ — pluginId строки integrations. Обработчик читает строку,
// разбирает payload чистым parse() плагина и отдаёт нормализованные события применителю своего вида плагина
// (messenger — applyMessengerEvents, O7a). Нет применителя — нет обработчика: строка ждёт в retry no_handler.
import type { NormalizedEvent, PluginId, PluginKind, PluginRegistry, InboxItem } from '@/integrations/contract';
import { pluginDeps, registry as defaultRegistry } from '@/integrations/registry';
import type { SystemActor } from '@/server/access';
import { loadInboxItem } from '@/server/domain/integrations';
import { applyMessengerEvents } from '@/server/domain/messenger';
import type { QueueHandler, QueueOutcome } from '@/server/platform/jobs';

export type InboxApplier = (
  actor: SystemActor,
  input: { integrationId: string; pluginId: PluginId; kind: InboxItem['kind']; events: NormalizedEvent[]; attempt: number },
) => Promise<QueueOutcome>;

const KINDS: ReadonlySet<string> = new Set<InboxItem['kind']>(['message', 'status', 'channel', 'call']);

/** Применители по видам плагинов: мессенджер — события в чаты, ленту и задачи (O7a); телефония — O7b. */
export const defaultAppliers: Partial<Record<PluginKind, InboxApplier>> = {
  messenger: (actor, input) => applyMessengerEvents(actor, pluginDeps(), input),
};

export function webhookHandlers(registry: PluginRegistry = defaultRegistry, appliers: Partial<Record<PluginKind, InboxApplier>> = defaultAppliers): Map<string, QueueHandler> {
  const out = new Map<string, QueueHandler>();
  for (const plugin of registry.all()) {
    const hook = plugin.webhook;
    const apply = appliers[plugin.kind];
    if (!hook || !apply) continue;
    out.set(plugin.id, async (actor, item) => {
      const row = await loadInboxItem(actor, item.id);
      if (!row) return { status: 'failed', error: 'missing' };
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
    });
  }
  return out;
}
