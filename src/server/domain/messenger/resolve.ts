// Клиент по номеру чата (D-271, дизайн §8.6). Один клиент → он; несколько → с последним касанием и задача РОП
// «проверить»; ни одного → для входящего новый клиент через общий путь приёма (intake/inbound.ts), для исходящего
// (оператор написал с телефона на новый номер) — никто. Событие мессенджера карточку не трогает.
import type { SystemActor } from '@/server/access';
import type { Sql } from '@/server/platform/db';
import { createInboundClient, findClientsByPhone, type InboundClientContext } from '../intake';
import { ensureAutoTask } from '../tasks';
import { cardOf, insertNotice, leadUser, userIdsByRoles } from './repo';
import type { MessengerSettings } from './types';

export interface ResolveInput {
  integrationId: string;
  spaceId: string;
  sourceKey: string;
  chatRef: string;
  digits: string;
  direction: 'in' | 'out';
  contactName: string | null;
  /** Владелец канала, через который пришло сообщение. */
  channelOwnerUserId: string | null;
  settings: MessengerSettings;
  now: number;
}

export type ResolveOutcome = { clientId: string | null; created: boolean };

/** Получатель задач и уведомлений РОП: lead пространства (роль `offHours`) или первый сотрудник РОП-уровня. */
export async function leadOf(tx: Sql, spaceId: string, settings: MessengerSettings): Promise<string | null> {
  return (await leadUser(tx, { spaceId, role: settings.leadRole })) ?? (await userIdsByRoles(tx, { spaceId, roles: settings.managerRoles }))[0] ?? null;
}

export async function resolveClient(tx: Sql, actor: SystemActor, input: ResolveInput): Promise<ResolveOutcome> {
  const { settings, now } = input;
  const found = await findClientsByPhone(tx, { spaceId: input.spaceId, digits: input.digits });
  let clients = found;

  if (clients.length === 0) {
    if (input.direction === 'out') return { clientId: null, created: false };
    const ctx: InboundClientContext = {
      spaceId: input.spaceId,
      sourceKey: input.sourceKey,
      phoneRules: settings.phoneRules,
      searchable: settings.searchable,
      calendar: settings.calendar,
      now,
    };
    const r = await createInboundClient(tx, actor, ctx, { digits: input.digits, contactName: input.contactName, preferredUserId: input.channelOwnerUserId });
    if (r.kind === 'created') return { clientId: r.clientId, created: true };
    if (r.kind === 'existing') clients = r.clients;
    else {
      // Стоп-лист или суточный предел: клиента нет, сообщение остаётся в чате; РОП узнаёт из уведомления
      const day = settings.calendar.localDay(now);
      const lead = await leadOf(tx, input.spaceId, settings);
      if (lead) {
        const key = r.kind === 'stop_list' ? `mdnc:${input.chatRef}:${day}` : `mflood:${input.integrationId}:clients:${day}`;
        await insertNotice(tx, {
          userId: lead,
          kind: r.kind === 'stop_list' ? 'messenger_dnc_unknown' : 'messenger_flood',
          entityType: 'messenger_chat',
          entityId: input.chatRef,
          params: r.kind === 'stop_list' ? {} : { limit: 200 },
          dedupeKey: `${key}:${lead}`,
          now,
        });
      }
      return { clientId: null, created: false };
    }
  }

  const best = clients[0] as { clientId: string };
  if (clients.length > 1) {
    // Номер у нескольких клиентов: берём с последним касанием, РОП проверяет вручную
    const card = await cardOf(tx, { clientId: best.clientId, spaceId: input.spaceId });
    const lead = await leadOf(tx, input.spaceId, settings);
    if (card && lead) {
      await ensureAutoTask(tx, actor, {
        spaceId: input.spaceId,
        clientId: best.clientId,
        source: 'review',
        kind: 'check',
        assigneeUserId: lead,
        dueAt: null,
        sourceKey: `review:chat:${input.chatRef}`,
        at: now,
      });
    }
  }
  return { clientId: best.clientId, created: false };
}
