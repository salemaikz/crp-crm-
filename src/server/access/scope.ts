// scopeSql — единственный способ получить фильтр «своё / команда / пространство / все + отношения»
// к сущностям с данными клиентов (ARCHITECTURE §5.2 п. 4–7, D-017, D-071, D-072). Импортируют только
// домен и доступ (ESLint, layers.test.ts).
//
// Как пользоваться в репозитории домена:
//   const q = scoped(sql);
//   const rows = await q`SELECT c.id FROM cards c WHERE c.id = ${id} AND ${scopeSql(viewer, 'card', 'card.read')}`;
//   const upd = await q`UPDATE cards c SET … WHERE c.id = ${id} AND ${scopeSql(viewer, 'card', 'card.outcome')}
//                       AND c.version = ${v} RETURNING c.id`;
//   if (upd.length === 0) await throwNotFoundOrConflict(viewer, sql, 'card', id);
//
// Правила охвата:
// - карточка: own — владелец или временный владелец; team — они же в моей команде; space — текущее
//   пространство; all — все пространства с членством; плюс отношения, дающие это разрешение;
// - клиент, контакты, номера, сделки, записи, звонки, заметки, лента, чаты — через карточку;
// - задачи: own — исполнитель я и карточка видна; иначе охват роли; плюс задачи передачи;
// - пишущее разрешение у роли «только чтение» — FALSE; у отношения — только из его списка действий.
import { access as coreAccess } from '@crm/core';
import type { ActiveRelation, Permission, Scope } from '@crm/core/access';
import type { Row, Sql } from '@/server/platform/db';
import { ConflictError, NotFoundError } from './errors';
import { assertIssued } from './registry';
import { FALSE, Frag, TRUE, anyOf, constText, flatten, frag, ident, toTemplate } from './sqlFrag';
import type { Actor, ScopedEntity, Viewer } from './types';

const { PERMISSION_INFO, consultantWindowDates } = coreAccess;

declare const FRAGMENT: unique symbol;

/** Непрозрачный SQL-фрагмент охвата. Собирается только здесь; вставляется через `scoped(sql)`. */
export interface ScopeFragment {
  readonly [FRAGMENT]: true;
}

export type ScopeOptions = {
  /** Псевдоним таблицы во внешнем запросе; по умолчанию — ENTITY_TABLES[entity].alias. */
  alias?: string;
};

/** Таблица и псевдоним по умолчанию для каждой охватываемой сущности. */
export const ENTITY_TABLES: Readonly<Record<ScopedEntity, { table: string; alias: string }>> = {
  card: { table: 'cards', alias: 'c' },
  client: { table: 'clients', alias: 'cl' },
  contact: { table: 'contacts', alias: 'ct' },
  client_phone: { table: 'client_phones', alias: 'cp' },
  deal: { table: 'deals', alias: 'd' },
  booking: { table: 'bookings', alias: 'b' },
  call: { table: 'calls', alias: 'ca' },
  note: { table: 'notes', alias: 'n' },
  client_event: { table: 'client_events', alias: 'ev' },
  task: { table: 'tasks', alias: 't' },
  handoff: { table: 'handoffs', alias: 'h' },
  messenger_chat: { table: 'messenger_chats', alias: 'mc' },
  event: { table: 'events', alias: 'e' },
};

/** Разрешение чтения, которым проверяется «видна ли строка» после неудачной мутации. */
export const ENTITY_READ_PERM: Readonly<Record<ScopedEntity, Permission>> = {
  card: 'card.read',
  client: 'client.read',
  contact: 'client.read',
  client_phone: 'client.read',
  deal: 'deal.read',
  booking: 'booking.read',
  call: 'card.read',
  note: 'card.read',
  client_event: 'card.read',
  task: 'task.read',
  handoff: 'handoff.read',
  messenger_chat: 'card.read',
  event: 'booking.read',
};

/** Статусы записи, которые держат окно консультанта (отменённая и перенесённая — нет). */
const LIVE_BOOKING = frag`('registered','confirmed','attended','no_show')`;
/** Статусы передачи, при которых отдел видит клиента. */
const LIVE_HANDOFF = frag`('pending','accepted')`;

type Access = { scope: Scope | null; rels: readonly ActiveRelation[] };

/** Охват и отношения для разрешения; «только чтение» не получает пишущих. */
function accessFor(v: Viewer, perm: Permission): Access {
  if (v.readOnly && PERMISSION_INFO[perm].kind === 'write') return { scope: null, rels: [] };
  const rels = v.relations.filter((r) => r.reads.includes(perm) || r.actions.includes(perm));
  return { scope: v.grants.get(perm) ?? null, rels };
}

function relOf<K extends ActiveRelation['key']>(rels: readonly ActiveRelation[], key: K): Extract<ActiveRelation, { key: K }> | undefined {
  return rels.find((r) => r.key === key) as Extract<ActiveRelation, { key: K }> | undefined;
}

// ---------- Карточка ----------

/** Охват роли на строке cards под псевдонимом A. */
function cardGrant(v: Viewer, scope: Scope | null, A: Frag): Frag {
  if (!scope || v.spaceId === null) return FALSE;
  const me = v.userId;
  const space = v.spaceId;
  const mine = frag`(${A}.owner_user_id = ${me} OR ${A}.acting_user_id = ${me})`;
  switch (scope) {
    case 'own':
      return frag`(${A}.space_id = ${space} AND ${mine})`;
    case 'team':
      if (v.teamId === null) return frag`(${A}.space_id = ${space} AND ${mine})`;
      return frag`(${A}.space_id = ${space} AND (${mine} OR EXISTS (SELECT 1 FROM memberships acc_tm WHERE acc_tm.space_id = ${A}.space_id AND acc_tm.team_id = ${v.teamId} AND (acc_tm.user_id = ${A}.owner_user_id OR acc_tm.user_id = ${A}.acting_user_id))))`;
    case 'space':
      return frag`(${A}.space_id = ${space})`;
    case 'all':
      return frag`(${A}.space_id = ANY(${[...v.spaceIds]}))`;
  }
}

/** Отношение на строке cards под псевдонимом A (только отношения уровня клиента). */
function cardRelation(v: Viewer, rel: ActiveRelation, A: Frag): Frag {
  if (v.spaceId === null) return FALSE;
  const me = v.userId;
  const space = v.spaceId;
  switch (rel.key) {
    case 'booked_with_me': {
      const w = consultantWindowDates(v.today, rel.params);
      return frag`(${A}.space_id = ${space} AND EXISTS (SELECT 1 FROM bookings acc_bw JOIN resources acc_rw ON acc_rw.id = acc_bw.resource_id WHERE acc_bw.client_id = ${A}.client_id AND acc_bw.space_id = ${A}.space_id AND acc_bw.kind = 'individual' AND acc_rw.user_id = ${me} AND acc_bw.status IN ${LIVE_BOOKING} AND acc_bw.booking_date BETWEEN ${w.from} AND ${w.to}))`;
    }
    case 'handoff_to_my_team':
      return frag`(EXISTS (SELECT 1 FROM handoffs acc_ht JOIN teams acc_tt ON acc_tt.id = acc_ht.team_id WHERE acc_ht.client_id = ${A}.client_id AND acc_ht.space_id_from = ${A}.space_id AND acc_tt.lead_user_id = ${me} AND acc_tt.space_id = ${space} AND acc_ht.status IN ${LIVE_HANDOFF}))`;
    case 'handoff_assigned_to_me':
      return frag`(EXISTS (SELECT 1 FROM handoffs acc_ha WHERE acc_ha.client_id = ${A}.client_id AND acc_ha.space_id_from = ${A}.space_id AND acc_ha.assignee_user_id = ${me} AND acc_ha.space_id_to = ${space} AND acc_ha.status IN ${LIVE_HANDOFF}))`;
    case 'duty_today':
      // Дежурство не открывает карточку и клиента: только список гостей (сущность booking).
      return FALSE;
  }
}

/** Видна ли строка cards A: охват роли или отношения уровня клиента. */
function cardLevel(v: Viewer, a: Access, A: Frag): Frag {
  return anyOf([cardGrant(v, a.scope, A), ...a.rels.map((r) => cardRelation(v, r, A))]);
}

/** EXISTS карточки с условием `link` (по псевдониму acc_c), видимой по `a`. */
function viaCard(v: Viewer, a: Access, link: (C: Frag) => Frag): Frag {
  const C = constText('acc_c');
  const level = cardLevel(v, a, C);
  if (level === FALSE) return FALSE;
  return frag`(EXISTS (SELECT 1 FROM cards acc_c WHERE ${link(C)} AND ${level}))`;
}

// ---------- Сущности ----------

function bookingPred(v: Viewer, perm: Permission, a: Access, X: Frag): Frag {
  const me = v.userId;
  const parts: Frag[] = [];
  // Через карточку: охват роли и отношения уровня клиента; «явка по своей записи» и дежурство — отдельно.
  const cardRels = a.rels.filter((r) => r.key !== 'duty_today' && !(r.key === 'booked_with_me' && perm === 'booking.attend'));
  parts.push(viaCard(v, { scope: a.scope, rels: cardRels }, (C) => frag`${C}.id = ${X}.card_id`));
  const bw = relOf(a.rels, 'booked_with_me');
  if (bw && perm === 'booking.attend' && v.spaceId !== null) {
    const w = consultantWindowDates(v.today, bw.params);
    parts.push(
      frag`(${X}.space_id = ${v.spaceId} AND ${X}.kind = 'individual' AND ${X}.status IN ${LIVE_BOOKING} AND ${X}.booking_date BETWEEN ${w.from} AND ${w.to} AND EXISTS (SELECT 1 FROM resources acc_rb WHERE acc_rb.id = ${X}.resource_id AND acc_rb.user_id = ${me}))`,
    );
  }
  if (relOf(a.rels, 'duty_today') && v.spaceId !== null) {
    // Явка дежурного — только по живой записи, как и у консультанта; список гостей видит и отменённых.
    const live = perm === 'booking.attend' ? frag`${X}.status IN ${LIVE_BOOKING} AND ` : frag``;
    parts.push(
      frag`(${live}EXISTS (SELECT 1 FROM event_duty acc_db JOIN events acc_eb ON acc_eb.id = acc_db.event_id WHERE acc_db.event_id = ${X}.event_id AND acc_db.user_id = ${me} AND acc_eb.event_date = ${v.today} AND acc_eb.space_id = ${v.spaceId}))`,
    );
  }
  return anyOf(parts);
}

function eventPred(v: Viewer, a: Access, X: Frag): Frag {
  if (v.spaceId === null) return FALSE;
  const parts: Frag[] = [];
  // Мероприятия — не данные клиента: охват роли любого уровня даёт мероприятия пространства.
  if (a.scope === 'all') parts.push(frag`(${X}.space_id = ANY(${[...v.spaceIds]}))`);
  else if (a.scope) parts.push(frag`(${X}.space_id = ${v.spaceId})`);
  if (relOf(a.rels, 'duty_today')) {
    parts.push(
      frag`(${X}.space_id = ${v.spaceId} AND ${X}.event_date = ${v.today} AND EXISTS (SELECT 1 FROM event_duty acc_de WHERE acc_de.event_id = ${X}.id AND acc_de.user_id = ${v.userId}))`,
    );
  }
  return anyOf(parts);
}

function taskPred(v: Viewer, a: Access, X: Frag): Frag {
  if (v.spaceId === null) return FALSE;
  const me = v.userId;
  const space = v.spaceId;
  const parts: Frag[] = [];
  const own = () => {
    // «Своё»: исполнитель я, и карточка клиента задачи мне видна (охват card.read и отношения).
    const card = viaCard(v, accessFor(v, 'card.read'), (C) => frag`${C}.client_id = ${X}.client_id AND ${C}.space_id = ${X}.space_id`);
    return card === FALSE ? FALSE : frag`(${X}.assignee_user_id = ${me} AND ${card})`;
  };
  switch (a.scope) {
    case null:
      break;
    case 'own':
      parts.push(own());
      break;
    case 'team':
      parts.push(
        v.teamId === null
          ? own()
          : frag`(${X}.space_id = ${space} AND (${X}.assignee_user_id = ${me} OR EXISTS (SELECT 1 FROM memberships acc_tmt WHERE acc_tmt.space_id = ${X}.space_id AND acc_tmt.team_id = ${v.teamId} AND acc_tmt.user_id = ${X}.assignee_user_id)))`,
      );
      break;
    case 'space':
      parts.push(frag`(${X}.space_id = ${space})`);
      break;
    case 'all':
      parts.push(frag`(${X}.space_id = ANY(${[...v.spaceIds]}))`);
      break;
  }
  if (relOf(a.rels, 'handoff_to_my_team')) {
    parts.push(
      frag`(${X}.source = 'handoff' AND EXISTS (SELECT 1 FROM handoffs acc_htt JOIN teams acc_ttt ON acc_ttt.id = acc_htt.team_id WHERE acc_htt.deal_id = ${X}.deal_id AND acc_ttt.lead_user_id = ${me} AND acc_ttt.space_id = ${space} AND acc_htt.status IN ${LIVE_HANDOFF}))`,
    );
  }
  if (relOf(a.rels, 'handoff_assigned_to_me')) {
    parts.push(
      frag`(${X}.source = 'handoff' AND EXISTS (SELECT 1 FROM handoffs acc_hat WHERE acc_hat.deal_id = ${X}.deal_id AND acc_hat.assignee_user_id = ${me} AND acc_hat.space_id_to = ${space} AND acc_hat.status IN ${LIVE_HANDOFF}))`,
    );
  }
  return anyOf(parts);
}

function handoffPred(v: Viewer, a: Access, X: Frag): Frag {
  if (v.spaceId === null) return FALSE;
  const me = v.userId;
  const space = v.spaceId;
  const parts: Frag[] = [];
  const inSpace = frag`(${X}.space_id_from = ${space} OR ${X}.space_id_to = ${space})`;
  switch (a.scope) {
    case null:
      break;
    case 'own':
      parts.push(frag`(${X}.assignee_user_id = ${me} AND ${inSpace})`);
      break;
    case 'team':
      parts.push(
        v.teamId === null
          ? frag`(${X}.assignee_user_id = ${me} AND ${inSpace})`
          : frag`((${X}.assignee_user_id = ${me} OR ${X}.team_id = ${v.teamId}) AND ${inSpace})`,
      );
      break;
    case 'space':
      parts.push(inSpace);
      break;
    case 'all':
      parts.push(frag`(${X}.space_id_from = ANY(${[...v.spaceIds]}) OR ${X}.space_id_to = ANY(${[...v.spaceIds]}))`);
      break;
  }
  if (relOf(a.rels, 'handoff_to_my_team')) {
    parts.push(
      frag`(${X}.status IN ${LIVE_HANDOFF} AND EXISTS (SELECT 1 FROM teams acc_th WHERE acc_th.id = ${X}.team_id AND acc_th.lead_user_id = ${me} AND acc_th.space_id = ${space}))`,
    );
  }
  if (relOf(a.rels, 'handoff_assigned_to_me')) {
    parts.push(frag`(${X}.status IN ${LIVE_HANDOFF} AND ${X}.assignee_user_id = ${me} AND ${X}.space_id_to = ${space})`);
  }
  return anyOf(parts);
}

function chatPred(v: Viewer, a: Access, X: Frag): Frag {
  if (v.spaceId === null) return FALSE;
  const CH = constText('acc_ch');
  const CM = constText('acc_cm');
  const level = cardLevel(v, a, CM);
  let unlinked: Frag = FALSE;
  if (a.scope === 'all') unlinked = frag`(${CH}.space_id = ANY(${[...v.spaceIds]}))`;
  else if (a.scope === 'space') unlinked = frag`(${CH}.space_id = ${v.spaceId})`;
  else if (a.scope) unlinked = frag`(${CH}.space_id = ${v.spaceId} AND ${CH}.owner_user_id = ${v.userId})`;
  if (level === FALSE && unlinked === FALSE) return FALSE;
  const linked =
    level === FALSE
      ? FALSE
      : frag`(${X}.client_id IS NOT NULL AND EXISTS (SELECT 1 FROM cards acc_cm WHERE acc_cm.client_id = ${X}.client_id AND acc_cm.space_id = ${CH}.space_id AND ${level}))`;
  const free = unlinked === FALSE ? FALSE : frag`(${X}.client_id IS NULL AND ${unlinked})`;
  return frag`(EXISTS (SELECT 1 FROM messenger_channels acc_ch WHERE acc_ch.id = ${X}.channel_id AND ${anyOf([linked, free])}))`;
}

/** Лента: видна, если видна карточка клиента или клиента, в которого он слит (цепочка, D-068). */
function clientEventPred(v: Viewer, a: Access, X: Frag): Frag {
  const C = constText('acc_ce');
  const level = cardLevel(v, a, C);
  if (level === FALSE) return FALSE;
  return frag`(EXISTS (SELECT 1 FROM cards acc_ce WHERE acc_ce.space_id = ${X}.space_id AND acc_ce.client_id IN (WITH RECURSIVE acc_chain(id, depth) AS (SELECT ${X}.client_id, 0 UNION ALL SELECT acc_cl.merged_into_id, acc_chain.depth + 1 FROM clients acc_cl JOIN acc_chain ON acc_cl.id = acc_chain.id WHERE acc_cl.merged_into_id IS NOT NULL AND acc_chain.depth < 8) SELECT acc_chain.id FROM acc_chain) AND ${level}))`;
}

function entityPred(v: Viewer, entity: ScopedEntity, perm: Permission, X: Frag): Frag {
  const a = accessFor(v, perm);
  if (a.scope === null && a.rels.length === 0) return FALSE;
  switch (entity) {
    case 'card':
      return cardLevel(v, a, X);
    case 'client':
      return viaCard(v, a, (C) => frag`${C}.client_id = ${X}.id`);
    case 'contact':
    case 'client_phone':
      return viaCard(v, a, (C) => frag`${C}.client_id = ${X}.client_id`);
    case 'deal':
    case 'call':
      return viaCard(v, a, (C) => frag`${C}.id = ${X}.card_id`);
    case 'note':
      return viaCard(v, a, (C) => frag`${C}.client_id = ${X}.client_id AND ${C}.space_id = ${X}.space_id`);
    case 'client_event':
      return clientEventPred(v, a, X);
    case 'booking':
      return bookingPred(v, perm, a, X);
    case 'event':
      return eventPred(v, a, X);
    case 'task':
      return taskPred(v, a, X);
    case 'handoff':
      return handoffPred(v, a, X);
    case 'messenger_chat':
      return chatPred(v, a, X);
  }
}

/**
 * Фрагмент WHERE для строк `entity` (под псевдонимом alias), доступных исполнителю по разрешению
 * `perm`. Нет доступа — `FALSE`; SystemActor — `TRUE`. Для пишущих `perm` отношения дают только
 * свои действия, а роль «только чтение» — `FALSE`. Ставится и в SELECT, и в UPDATE/DELETE.
 */
export function scopeSql(actor: Actor, entity: ScopedEntity, perm: Permission, opts: ScopeOptions = {}): ScopeFragment {
  assertIssued(actor);
  if (!Object.hasOwn(ENTITY_TABLES, entity)) throw new Error(`scopeSql: неизвестная сущность ${String(entity)}`);
  if (!Object.hasOwn(PERMISSION_INFO, perm)) throw new Error(`scopeSql: неизвестное разрешение ${String(perm)}`);
  const X = ident(opts.alias ?? ENTITY_TABLES[entity].alias);
  if (actor.kind === 'system') return TRUE as unknown as ScopeFragment;
  const p = entityPred(actor, entity, perm, X);
  return (p === FALSE || p === TRUE ? p : frag`(${p})`) as unknown as ScopeFragment;
}

/** Тег запроса, который принимает ScopeFragment среди значений: `scoped(sql)\`… AND ${scope}\``. */
export type ScopedSql = <T = Row>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T[]>;

export function scoped(sql: Sql): ScopedSql {
  return <T = Row>(strings: TemplateStringsArray, ...values: unknown[]) => {
    const f = flatten(strings, values);
    return sql<T>(toTemplate(f.strings), ...f.values);
  };
}

/** Для тестов и отладки: текст с $n и параметры фрагмента. */
export function inspectScope(fragment: ScopeFragment): { text: string; values: unknown[] } {
  const f = fragment as unknown as Frag;
  return { text: f.strings.map((s, i) => (i === 0 ? s : `$${i}${s}`)).join(''), values: [...f.values] };
}

/**
 * После UPDATE … WHERE id = $1 AND <scope> AND version = $v, обновившего 0 строк: повторное чтение
 * с охватом чтения. Не видна — NotFoundError (404), видна — ConflictError (409). Всегда бросает.
 */
export async function throwNotFoundOrConflict(actor: Actor, sql: Sql, entity: ScopedEntity, id: string): Promise<never> {
  const { table, alias } = ENTITY_TABLES[entity];
  const scope = scopeSql(actor, entity, ENTITY_READ_PERM[entity]);
  const A = constText(alias);
  const rows = await scoped(sql)`SELECT 1 AS hit FROM ${constText(table)} ${A} WHERE ${A}.id = ${id} AND ${scope}`;
  throw rows.length > 0 ? new ConflictError() : new NotFoundError();
}
