// Применение нормализованных событий мессенджера (O7a, дизайн docs/reports-plugins-design.md §8.5). Одна транзакция
// на строку webhook_inbox. Правило, которое нельзя нарушать: событие мессенджера НИКОГДА само не меняет состояние
// карточки и не снимает «Не звонить» — только лента, чат и задачи. Канал обязан принадлежать этому подключению
// (телу вебхука не доверяем). Тексты сообщений в логи не попадают: пишутся только коды.
import { time } from '@crm/core';
import type { MessengerChannelEvent, MessengerMessageEvent, MessengerStatusEvent, NormalizedEvent, PluginId } from '@/integrations/contract';
import type { SystemActor } from '@/server/access';
import { getDb, type Sql } from '@/server/platform/db';
import { phoneHmac } from '@/server/platform/hmac';
import type { QueueOutcome } from '@/server/platform/jobs';
import { insertClientEvent } from '../cards/repo';
import { buildCtx, loadIntegrationRow } from '../integrations';
import { closeAutoTaskByKey, ensureAutoTask } from '../tasks';
import { stopListHits } from '../intake/repo';
import {
  adminIds,
  applyStatus,
  cardOf,
  countReplyTasksSince,
  findChannel,
  insertNotice,
  lockIntegration,
  setChannelState,
  setChatClient,
  touchChat,
  upsertChannels,
  upsertChat,
  upsertMessage,
  userIdsByRoles,
  type ChannelRow,
  type IntegrationHead,
} from './repo';
import { leadOf, resolveClient } from './resolve';
import { loadMessengerSettings, MessengerSettingsError } from './settings';
import type { MessengerDeps, MessengerSettings } from './types';

/** Предел задач «Ответить» по известным клиентам в сутки на подключение (INTEGRATIONS §3.2 п. 6). */
export const REPLY_TASKS_PER_DAY = 500;
/** Сверка каналов у провайдера при неизвестном channelId — не чаще раза в 5 минут на подключение. */
export const CHANNEL_REFRESH_MS = 5 * 60_000;
/** Статус раньше сообщения: повтор, с 3-й попытки событие считается устаревшим. */
const STATUS_RETRIES = 2;

const lastRefresh = new Map<string, number>();

/** Только тесты: сбросить память о последней сверке каналов. */
export function resetChannelRefreshForTests(): void {
  lastRefresh.clear();
}

function log(code: string, extra: Record<string, string | number> = {}): void {
  console.warn(JSON.stringify({ level: 'warn', code, ...extra }));
}

interface Ctx {
  tx: Sql;
  actor: SystemActor;
  integration: IntegrationHead;
  settings: MessengerSettings;
  sourceKey: string | null;
  attempt: number;
  now: number;
}

/** Источник новых клиентов: `config.sourceKey` подключения, иначе первый источник вида messenger в настройках. */
function sourceKeyOf(integration: IntegrationHead, settings: MessengerSettings): string | null {
  const cfg = integration.config as { sourceKey?: unknown } | null;
  const own = typeof cfg?.sourceKey === 'string' ? cfg.sourceKey : null;
  if (own) return settings.messengerSources.includes(own) ? own : null;
  return settings.messengerSources[0] ?? null;
}

/** Получатели тревог по каналу: администраторы установки и РОП-уровень пространства. */
async function alertRecipients(tx: Sql, spaceId: string, settings: MessengerSettings): Promise<string[]> {
  const ids = new Set([...(await adminIds(tx)), ...(await userIdsByRoles(tx, { spaceId, roles: settings.managerRoles }))]);
  return [...ids].sort();
}

async function applyChannel(c: Ctx, ev: MessengerChannelEvent): Promise<void> {
  const channel = await findChannel(c.tx, { integrationId: c.integration.id, ref: ev.channelRef });
  if (!channel) return void log('foreign_channel', { kind: 'channel' });
  const applied = await setChannelState(c.tx, { id: channel.id, state: ev.state, at: ev.at, now: c.now });
  // Здоровым считается только active; устаревшее событие (раньше записанного состояния) тревогу не поднимает
  if (!applied || ev.state === 'active') return;
  const day = c.settings.calendar.localDay(c.now);
  for (const userId of await alertRecipients(c.tx, channel.spaceId, c.settings)) {
    await insertNotice(c.tx, {
      userId,
      kind: 'messenger_channel_down',
      entityType: 'messenger_channel',
      entityId: channel.id,
      params: { state: ev.state.slice(0, 32) },
      dedupeKey: `mch:${channel.id}:${ev.state}:${day}:${userId}`,
      now: c.now,
    });
  }
}

async function applyDeliveryStatus(c: Ctx, ev: MessengerStatusEvent): Promise<QueueOutcome | null> {
  const r = await applyStatus(c.tx, { integrationId: c.integration.id, providerMessageId: ev.providerMessageId, status: ev.status, at: ev.at });
  // Сообщения ещё нет (статус пришёл раньше): повторим; с 3-й попытки считаем событие устаревшим
  if (!r.found && c.attempt <= STATUS_RETRIES) return { status: 'retry', error: 'message_not_yet' };
  return null;
}

async function applyMessage(c: Ctx, channel: ChannelRow, ev: MessengerMessageEvent): Promise<void> {
  const { tx, settings, now } = c;
  const spaceId = channel.spaceId;
  const chat = await upsertChat(tx, { channelId: channel.id, chatType: ev.chatType, chatId: ev.chatId, now });
  let clientId = chat.clientId;
  if (!clientId && ev.chatDigits !== '') {
    if (!c.sourceKey && ev.direction === 'in') throw new MessengerSettingsError();
    const r = await resolveClient(tx, c.actor, {
      integrationId: c.integration.id,
      spaceId,
      sourceKey: c.sourceKey ?? '',
      chatRef: chat.id,
      digits: ev.chatDigits,
      direction: ev.direction,
      contactName: ev.contactName,
      channelOwnerUserId: channel.ownerUserId,
      settings,
      now,
    });
    clientId = r.clientId;
    if (clientId) await setChatClient(tx, chat.id, clientId);
  }

  const msg = await upsertMessage(tx, {
    integrationId: c.integration.id,
    chatRef: chat.id,
    providerMessageId: ev.providerMessageId,
    direction: ev.direction,
    msgType: ev.msgType,
    body: ev.text,
    hasAttachment: ev.hasAttachment,
    status: ev.status,
    authorRef: ev.authorRef,
    isEdited: ev.isEdited,
    isDeleted: ev.isDeleted,
    sentAt: ev.sentAt,
    now,
  });
  // Повтор или правка уже известного сообщения: лента и задачи не создаются повторно
  if (!msg.inserted || !clientId) {
    await touchChat(tx, { chatRef: chat.id, at: ev.sentAt, inbound: ev.direction === 'in' && msg.inserted, awaitingReply: null });
    return;
  }

  await insertClientEvent(tx, {
    clientId,
    spaceId,
    kind: 'message',
    actorId: msg.authorUserId,
    at: ev.sentAt,
    refType: 'messenger_message',
    refId: msg.id,
    data: { direction: ev.direction, msgType: ev.msgType, hasAttachment: ev.hasAttachment },
  });

  const card = await cardOf(tx, { clientId, spaceId });
  let awaiting: boolean | null = null;
  if (ev.direction === 'out') {
    await closeAutoTaskByKey(tx, c.actor, { sourceKey: `reply:${chat.id}`, at: now });
    awaiting = false;
  } else if (card) {
    awaiting = await inboundTasks(c, { chatRef: chat.id, clientId, spaceId, card, msgId: msg.id, ev });
  }
  await touchChat(tx, { chatRef: chat.id, at: ev.sentAt, inbound: ev.direction === 'in', awaitingReply: awaiting });
}

/** Задачи по входящему. Возвращает новое значение `awaiting_reply` (null — не менять). */
async function inboundTasks(
  c: Ctx,
  a: { chatRef: string; clientId: string; spaceId: string; card: { id: string; state: string; ownerUserId: string | null; actingUserId: string | null }; msgId: string; ev: MessengerMessageEvent },
): Promise<boolean | null> {
  const { tx, settings, now } = c;
  const lead = await leadOf(tx, a.spaceId, settings);
  const worker = a.card.actingUserId ?? a.card.ownerUserId ?? lead;
  const due = now + settings.replyMinutes * 60_000;

  if (a.ev.msgType === 'missing_call') {
    if (!worker) return null;
    await ensureAutoTask(tx, c.actor, { spaceId: a.spaceId, clientId: a.clientId, source: 'missed_call', kind: 'call', assigneeUserId: worker, dueAt: due, sourceKey: `missed:wa:${a.msgId}`, at: now });
    return null;
  }
  // «Не звонить»: состояние не меняем, сообщаем РОП
  const dnc = a.card.state === 'do_not_call' || (a.ev.chatDigits !== '' && ((await stopListHits(tx, [phoneHmac(a.ev.chatDigits)])).size > 0));
  if (dnc) {
    if (lead) await ensureAutoTask(tx, c.actor, { spaceId: a.spaceId, clientId: a.clientId, source: 'dnc_inbound', kind: 'check', assigneeUserId: lead, dueAt: due, sourceKey: `dnc_inbound:${a.clientId}`, at: now });
    return null;
  }
  if (!worker) return null;
  const dayStart = time.fromLocalTime(settings.calendar.localDay(now), '00:00', settings.calendar.timezone);
  const open = await countReplyTasksSince(tx, { integrationId: c.integration.id, since: dayStart });
  if (open >= REPLY_TASKS_PER_DAY) {
    const day = settings.calendar.localDay(now);
    for (const userId of await alertRecipients(tx, a.spaceId, settings)) {
      await insertNotice(tx, {
        userId,
        kind: 'messenger_flood',
        entityType: 'integration',
        entityId: c.integration.id,
        params: { limit: REPLY_TASKS_PER_DAY },
        dedupeKey: `mflood:${c.integration.id}:tasks:${day}:${userId}`,
        now,
      });
    }
    return null;
  }
  await ensureAutoTask(tx, c.actor, { spaceId: a.spaceId, clientId: a.clientId, source: 'inbound_message', kind: 'message', assigneeUserId: worker, dueAt: due, sourceKey: `reply:${a.chatRef}`, at: now });
  return true;
}

/**
 * События строки inbox → записи. Сверка каналов у провайдера (при неизвестном channelId) идёт ДО транзакции:
 * сетевой вызов не держит блокировки. Результат — исход для очереди: done / retry / failed.
 */
export async function applyMessengerEvents(
  actor: SystemActor,
  deps: MessengerDeps,
  input: { integrationId: string; pluginId: PluginId; events: readonly NormalizedEvent[]; attempt?: number },
): Promise<QueueOutcome> {
  const now = (deps.now ?? Date.now)();
  const db = await getDb();
  await refreshChannelsIfNeeded(deps, input, now);

  try {
    return await db.tx(async (tx) => {
      const integration = await lockIntegration(tx, input.integrationId);
      // Выключенное подключение: событие сбрасывается (done), чтобы очередь не копилась
      if (!integration || !integration.enabled) return { status: 'done' } as QueueOutcome;
      const settings = await loadMessengerSettings(integration.spaceId);
      const c: Ctx = { tx, actor, integration, settings, sourceKey: sourceKeyOf(integration, settings), attempt: input.attempt ?? 1, now };
      let outcome: QueueOutcome = { status: 'done' };
      for (const ev of input.events) {
        if (ev.type === 'channel') await applyChannel(c, ev);
        else if (ev.type === 'status') {
          const r = await applyDeliveryStatus(c, ev);
          if (r) outcome = r;
        } else if (ev.type === 'message') {
          // Канал обязан принадлежать этому подключению (INTEGRATIONS §3.2 п. 3)
          const channel = await findChannel(tx, { integrationId: integration.id, ref: ev.channelRef });
          if (!channel) {
            log('foreign_channel', { kind: 'message' });
            continue;
          }
          await applyMessage(c, channel, ev);
        }
      }
      return outcome;
    });
  } catch (e) {
    if (e instanceof MessengerSettingsError) return { status: 'failed', error: 'invalid_settings' };
    throw e;
  }
}

/** Неизвестный channelId: не чаще раза в 5 минут на подключение сверяем каналы у провайдера (вне транзакции). */
async function refreshChannelsIfNeeded(deps: MessengerDeps, input: { integrationId: string; pluginId: PluginId; events: readonly NormalizedEvent[] }, now: number): Promise<void> {
  const refs = [...new Set(input.events.flatMap((e) => (e.type === 'message' || e.type === 'channel' ? [e.channelRef] : [])))];
  if (refs.length === 0) return;
  const db = await getDb();
  const known = await Promise.all(refs.map((ref) => findChannel(db.sql, { integrationId: input.integrationId, ref })));
  if (known.every((k) => k !== null)) return;
  const last = lastRefresh.get(input.integrationId) ?? 0;
  if (now - last < CHANNEL_REFRESH_MS) return;
  lastRefresh.set(input.integrationId, now);
  const plugin = deps.registry.messenger(input.pluginId);
  const row = await loadIntegrationRow(input.integrationId);
  if (!plugin?.listChannels || !row || !row.enabled) return;
  try {
    const r = await plugin.listChannels(buildCtx(deps, plugin, row));
    if (!r.ok) return;
    const head = await lockIntegration(db.sql, input.integrationId);
    if (head) await upsertChannels(db.sql, { integrationId: head.id, spaceId: head.spaceId, channels: r.channels, now });
  } catch {
    log('channel_refresh_failed');
  }
}
