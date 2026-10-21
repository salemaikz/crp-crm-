// Новый клиент из входящего сообщения мессенджера (O7a, D-271, дизайн docs/reports-plugins-design.md §8.6).
// Один путь создания клиента для всех источников: общая блокировка приёма, стоп-лист, дедуп по номеру. Своего кода
// создания клиента в модуле мессенджера нет. Вызывается внутри транзакции воркера; ПДн в логи и события не пишутся.
import { fields, names, phone, time } from '@crm/core';
import type { SystemActor } from '@/server/access';
import { newId, type Sql } from '@/server/platform/db';
import { phoneHmac } from '@/server/platform/hmac';
import { formatKzPhone } from '@/shared/tel';
import { assignInbound } from '../distribution';
import * as repo from './repo';

/** Предел новых клиентов из мессенджера в сутки (INTEGRATIONS §3.2 п. 6): защита от залива при утечке адреса вебхука. */
export const INBOUND_NEW_CLIENTS_PER_DAY = 200;

export interface InboundClientContext {
  spaceId: string;
  /** Ключ источника вида `messenger` из настроек (ключ задаётся в настройках установки). */
  sourceKey: string;
  phoneRules: phone.PhoneRules;
  /** Ключи полей клиента для search_norm (`clients/config`). */
  searchable: readonly string[];
  calendar: Pick<time.WorkCalendar, 'localDay' | 'isWorkingMoment' | 'timezone'>;
  now: number;
}

export type InboundClientResult =
  /** Номер уже есть у клиентов (гонка двух вебхуков или клиент появился между проверками): выбирает вызывающий. */
  | { kind: 'existing'; clients: { clientId: string; lastTouchAt: number | null }[] }
  | { kind: 'stop_list' }
  | { kind: 'limit' }
  | { kind: 'created'; clientId: string; cardId: string; ownerUserId: string | null };

/** Клиенты по номеру (слитые — выжившие), последний по касанию первым. */
export async function findClientsByPhone(tx: Sql, a: { spaceId: string; digits: string }): Promise<{ clientId: string; lastTouchAt: number | null }[]> {
  return (await repo.clientsByDigits(tx, a)).map((r) => ({ clientId: r.clientId, lastTouchAt: r.lastTouchAt }));
}

export async function createInboundClient(
  tx: Sql,
  actor: SystemActor,
  ctx: InboundClientContext,
  input: { digits: string; contactName: string | null; preferredUserId: string | null },
): Promise<InboundClientResult> {
  await repo.lockIntake(tx);
  // 1. Повторный поиск под блокировкой: два вебхука с одним новым номером не создают двух клиентов
  const existing = await findClientsByPhone(tx, { spaceId: ctx.spaceId, digits: input.digits });
  if (existing.length > 0) return { kind: 'existing', clients: existing };
  // 2. Стоп-лист: клиента не создаём
  const hits = await repo.stopListHits(tx, [phoneHmac(input.digits)]);
  if (hits.size > 0) return { kind: 'stop_list' };
  // 3. Суточный предел
  const dayStart = time.fromLocalTime(ctx.calendar.localDay(ctx.now), '00:00', ctx.calendar.timezone);
  if ((await repo.countSourceClientsSince(tx, { sourceKey: ctx.sourceKey, since: dayStart })) >= INBOUND_NEW_CLIENTS_PER_DAY) return { kind: 'limit' };

  // 4. Клиент, номер, источник, карточка в пуле, события ленты
  const name = (input.contactName ?? '').trim() || formatKzPhone(input.digits);
  const parsed = phone.parsePhone(input.digits, ctx.phoneRules);
  const clientId = newId();
  const cardId = newId();
  await repo.insertClient(tx, {
    id: clientId,
    kind: 'person',
    name,
    nameNorm: names.normalizePersonName(name),
    legalForm: '',
    orgId: '',
    iinHmac: null,
    region: '',
    address: '',
    email: '',
    website: '',
    custom: {},
    searchNorm: fields.buildSearchNorm({ name, orgId: '', phones: [input.digits], custom: {}, searchable: ctx.searchable }),
    sourceKey: ctx.sourceKey,
    now: ctx.now,
    sourceKind: 'messenger',
  });
  await repo.addPhones(tx, clientId, [{ id: newId(), digits: input.digits, kind: parsed?.kind ?? 'unknown', ext: '', isPrimary: true }], ctx.now);
  await repo.addSource(tx, { id: newId(), clientId, sourceKey: ctx.sourceKey, keyId: null, externalId: null, now: ctx.now, sourceKind: 'messenger' });
  await repo.insertCard(tx, { id: cardId, spaceId: ctx.spaceId, clientId, holdReason: '', holdCode: '', now: ctx.now });
  await repo.insertClientEventRow(tx, { clientId, spaceId: ctx.spaceId, kind: 'client.created', at: ctx.now, data: { sourceKind: 'messenger' } });
  await repo.insertClientEventRow(tx, { clientId, spaceId: ctx.spaceId, kind: 'card.created', at: ctx.now, data: { sourceKey: ctx.sourceKey } });

  // 5. Владелец карточки по правилу входящих
  const assigned = await assignInbound(tx, actor, {
    spaceId: ctx.spaceId,
    cardId,
    clientId,
    preferredUserId: input.preferredUserId,
    workingNow: ctx.calendar.isWorkingMoment(ctx.now),
    now: ctx.now,
  });
  return { kind: 'created', clientId, cardId, ownerUserId: assigned.ownerUserId };
}
