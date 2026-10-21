// Синтетика прогона изоляции (ARCHITECTURE §5.3): пресет первого клиента, операторы A и B, РОП,
// консультант, дежурный, руководитель отдела и маркетолог, директор, администратор без роли,
// 200 карточек с номерами +7 709 … (код не выдан ни одному оператору связи). Имена выдуманы.
// Каркас: потоки дописывают свои объекты (записи, сделки, задачи) рядом, не меняя существующих id.
import type { Sql } from '../../../src/server/platform/db';
import { addDays } from '../../../packages/core/src/access';

/** Момент «сейчас» прогона: среда 28.10.2026 11:00 по Алматы (UTC+5). */
export const SEED_NOW = Date.UTC(2026, 9, 28, 6, 0);
export const SEED_TODAY = '2026-10-28';
export const SEED_TZ = 'Asia/Almaty';

export const SPACE = 'sp-sales';
export const TEAM_MKT = 'team-mkt';

export const U = {
  opA: 'u-op-a',
  opB: 'u-op-b',
  rop: 'u-rop',
  consultant: 'u-cons',
  duty: 'u-duty',
  mktHead: 'u-mkt-head',
  marketer: 'u-mkt',
  director: 'u-dir',
  admin: 'u-admin',
  disabled: 'u-gone',
} as const;

/**
 * Ключ роли участника в пресете прогона. Роли ЦРП (operator, rop, …) переводятся в роли base по смыслу
 * охвата: operator и сотрудники отделов — manager (своё), rop — lead (всё пространство), director — observer.
 */
export function roleOf(crpKey: string): string {
  if (process.env.ISOLATION_PRESET !== 'base') return crpKey;
  const map: Record<string, string> = { operator: 'manager', rop: 'lead', consultant: 'manager', marketing_head: 'manager', marketer: 'manager', director: 'observer' };
  return map[crpKey] ?? crpKey;
}

/** Карточка и клиент номер i оператора A или B: 'cd-a-1', 'cl-b-17'. */
export const cardOf = (who: 'a' | 'b', i: number) => `cd-${who}-${i}`;
export const clientOf = (who: 'a' | 'b', i: number) => `cl-${who}-${i}`;
/** Номер клиента: 7709 + 7 цифр; у A — 7709000xxxx, у B — 7709100xxxx. */
export const phoneOf = (who: 'a' | 'b', i: number) => `7709${who === 'a' ? '0' : '1'}${String(i).padStart(6, '0')}`;
/** Название клиента (поиск по названию). */
export const nameOf = (who: 'a' | 'b', i: number) => `ТОО Синтетика ${who === 'a' ? 'Альфа' : 'Бета'} ${i}`;

/** Именованные объекты сценариев (все у клиентов оператора B, чтобы A их не видел). */
export const FX = {
  /** БК у консультанта завтра — клиент в окне. */
  bkInWindow: { booking: 'bk-in', client: clientOf('b', 2), card: cardOf('b', 2), date: addDays(SEED_TODAY, 1) },
  /** БК через 2 дня — окно ещё не открылось. */
  bkFuture: { booking: 'bk-future', client: clientOf('b', 3), card: cardOf('b', 3), date: addDays(SEED_TODAY, 2) },
  /** БК 31 день назад — окно закрылось. */
  bkPast: { booking: 'bk-past', client: clientOf('b', 4), card: cardOf('b', 4), date: addDays(SEED_TODAY, -31) },
  /** БК в окне, но у другого консультанта (РОП как ресурс). */
  bkOther: { booking: 'bk-other', client: clientOf('b', 9), card: cardOf('b', 9), date: SEED_TODAY },
  /** Групповое мероприятие сегодня с дежурным; гость — клиент B5. */
  eventToday: { event: 'ev-today', booking: 'bk-guest-today', client: clientOf('b', 5), card: cardOf('b', 5) },
  /** То же завтра: дежурный ещё не видит. */
  eventTomorrow: { event: 'ev-tomorrow', booking: 'bk-guest-tomorrow', client: clientOf('b', 6), card: cardOf('b', 6) },
  /** Передача отделу маркетинга (ждёт), исполнитель — маркетолог. */
  handoffLive: { handoff: 'ho-live', deal: 'dl-b7', client: clientOf('b', 7), card: cardOf('b', 7), task: 'tk-ho-live' },
  /** Отклонённая передача — отдел клиента больше не видит. */
  handoffDeclined: { handoff: 'ho-declined', deal: 'dl-b8', client: clientOf('b', 8), card: cardOf('b', 8) },
} as const;

export type SeedOptions = { cardsPerOperator?: number };

/** Наполнить пустую схему (после migrate). Порядок вставки — родители раньше детей (FK, D-067). */
export async function seedIsolation(sql: Sql, opts: SeedOptions = {}): Promise<void> {
  const n = opts.cardsPerOperator ?? 100;
  const t = SEED_NOW - 86_400_000;
  await sql`INSERT INTO spaces (id, key, is_default, created_at) VALUES (${SPACE}, 'sales', TRUE, ${t})`;

  const users: Array<[string, string, boolean, 'active' | 'disabled']> = [
    [U.opA, 'Оператор Синтетик А', false, 'active'],
    [U.opB, 'Оператор Синтетик Б', false, 'active'],
    [U.rop, 'РОП Синтетик', false, 'active'],
    [U.consultant, 'Консультант Синтетик', false, 'active'],
    [U.duty, 'Дежурный Синтетик', false, 'active'],
    [U.mktHead, 'Руководитель Синтетик', false, 'active'],
    [U.marketer, 'Маркетолог Синтетик', false, 'active'],
    [U.director, 'Директор Синтетик', false, 'active'],
    [U.admin, 'Администратор Синтетик', true, 'active'],
    [U.disabled, 'Уволенный Синтетик', false, 'disabled'],
  ];
  for (const [i, [id, name, isAdmin, status]] of users.entries()) {
    await sql`INSERT INTO users (id, phone_digits, name, is_admin, status, created_at)
              VALUES (${id}, ${`7709900${String(i).padStart(4, '0')}`}, ${name}, ${isAdmin}, ${status}, ${t})`;
  }
  await sql`INSERT INTO teams (id, space_id, key, lead_user_id, created_at) VALUES (${TEAM_MKT}, ${SPACE}, 'marketing', ${U.mktHead}, ${t})`;

  const members: Array<[string, string, string | null]> = [
    [U.opA, 'operator', null],
    [U.opB, 'operator', null],
    [U.rop, 'rop', null],
    [U.consultant, 'consultant', null],
    [U.duty, 'operator', null],
    [U.mktHead, 'marketing_head', TEAM_MKT],
    [U.marketer, 'marketer', TEAM_MKT],
    [U.director, 'director', null],
    [U.disabled, 'operator', null],
  ];
  for (const [user, roleKey, team] of members) {
    await sql`INSERT INTO memberships (user_id, space_id, role_key, team_id, in_distribution, created_at, updated_at)
              VALUES (${user}, ${SPACE}, ${roleOf(roleKey)}, ${team}, ${roleKey === 'operator'}, ${t}, ${t})`;
  }

  // Клиенты, номера и карточки операторов A и B (по n штук).
  for (const [who, owner] of [['a', U.opA], ['b', U.opB]] as const) {
    const label = who === 'a' ? 'Альфа' : 'Бета';
    const digitPrefix = who === 'a' ? '77090' : '77091';
    await sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
              SELECT 'cl-' || ${who} || '-' || i, 'company', 'ТОО Синтетика ' || ${label} || ' ' || i,
                     lower('синтетика ' || ${label} || ' ' || i),
                     lower('ТОО Синтетика ' || ${label} || ' ' || i) || ' ' || ${digitPrefix} || lpad(i::text, 6, '0'),
                     'import', ${t}, ${t}
                FROM generate_series(1, ${n}::int) AS i`;
    await sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at)
              SELECT 'ph-' || ${who} || '-' || i, 'cl-' || ${who} || '-' || i, ${digitPrefix} || lpad(i::text, 6, '0'),
                     'mobile', TRUE, ${t}
                FROM generate_series(1, ${n}::int) AS i`;
    await sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, assigned_at, created_at, updated_at)
              SELECT 'cd-' || ${who} || '-' || i, ${SPACE}, 'cl-' || ${who} || '-' || i, ${owner}, 'retry', ${t}, ${t}, ${t}
                FROM generate_series(1, ${n}::int) AS i`;
    // Заметка, событие ленты, звонок и задача по первой карточке каждого оператора.
    await sql`INSERT INTO notes (id, client_id, space_id, author_id, body, created_at)
              VALUES (${`nt-${who}-1`}, ${clientOf(who, 1)}, ${SPACE}, ${owner}, 'синтетическая заметка', ${t})`;
    await sql`INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at)
              VALUES (${`ce-${who}-1`}, ${clientOf(who, 1)}, ${SPACE}, 'call', ${owner}, ${t})`;
    await sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind,
                                 applied, occurred_at, received_at, config_rev)
              VALUES (${`call-${who}-1`}, ${SPACE}, ${cardOf(who, 1)}, ${clientOf(who, 1)}, ${owner}, 'ui', ${phoneOf(who, 1)},
                      'no_answer', 'no_answer', 'applied', ${t}, ${t}, 1)`;
    await sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, assignee_user_id, created_at)
              VALUES (${`tk-${who}-1`}, ${SPACE}, ${clientOf(who, 1)}, 'call', 'callback', 'Перезвонить', ${owner}, ${t})`;
    await sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id,
                                 stage_changed_at, created_by, created_at, updated_at)
              VALUES (${`dl-${who}-1`}, ${SPACE}, 'sales', 'negotiation', 'open', ${clientOf(who, 1)}, ${cardOf(who, 1)}, ${owner},
                      ${t}, ${owner}, ${t}, ${t})`;
  }

  // Консультант (ресурс) и РОП как второй ресурс; индивидуальные записи для окна.
  await sql`INSERT INTO resources (id, space_id, user_id, slot_min, created_at, updated_at) VALUES ('rs-cons', ${SPACE}, ${U.consultant}, 60, ${t}, ${t})`;
  await sql`INSERT INTO resources (id, space_id, user_id, slot_min, created_at, updated_at) VALUES ('rs-rop', ${SPACE}, ${U.rop}, 60, ${t}, ${t})`;
  const individual: Array<[{ booking: string; client: string; card: string; date: string }, string]> = [
    [FX.bkInWindow, 'rs-cons'],
    [FX.bkFuture, 'rs-cons'],
    [FX.bkPast, 'rs-cons'],
    [FX.bkOther, 'rs-rop'],
  ];
  for (const [b, res] of individual) {
    await sql`INSERT INTO bookings (id, space_id, kind, event_type_key, resource_id, client_id, card_id, booking_date, start_time,
                                    starts_at, duration_min, booked_by_user_id, responsible_user_id, created_at, updated_at)
              VALUES (${b.booking}, ${SPACE}, 'individual', 'consult', ${res}, ${b.client}, ${b.card}, ${b.date}, '11:00',
                      ${t}, 60, ${U.opB}, ${U.opB}, ${t}, ${t})`;
  }

  // Групповые мероприятия сегодня и завтра с дежурным; по одному гостю у каждого.
  for (const [ev, date] of [[FX.eventToday, SEED_TODAY], [FX.eventTomorrow, addDays(SEED_TODAY, 1)]] as const) {
    await sql`INSERT INTO events (id, space_id, event_type_key, event_date, start_time, starts_at, duration_min, capacity, created_at, updated_at)
              VALUES (${ev.event}, ${SPACE}, 'group', ${date}, '15:00', ${t}, 180, 30, ${t}, ${t})`;
    await sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES (${ev.event}, ${U.duty}, ${t})`;
    await sql`INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, client_id, card_id, booking_date, start_time,
                                    starts_at, duration_min, booked_by_user_id, responsible_user_id, created_at, updated_at)
              VALUES (${ev.booking}, ${SPACE}, 'group', 'group', ${ev.event}, ${ev.client}, ${ev.card}, ${date}, '15:00',
                      ${t}, 180, ${U.opB}, ${U.opB}, ${t}, ${t})`;
  }

  // Передачи отделу маркетинга: живая (с задачей маркетологу) и отклонённая.
  for (const [h, status] of [[FX.handoffLive, 'pending'], [FX.handoffDeclined, 'declined']] as const) {
    await sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, won_at,
                                 stage_changed_at, created_by, created_at, updated_at)
              VALUES (${h.deal}, ${SPACE}, 'sales', 'won', 'won', ${h.client}, ${h.card}, ${U.opB}, ${t}, ${t}, ${U.opB}, ${t}, ${t})`;
    await sql`INSERT INTO handoffs (id, space_id_from, space_id_to, team_id, deal_id, client_id, status, assignee_user_id, due_at, created_at)
              VALUES (${h.handoff}, ${SPACE}, ${SPACE}, ${TEAM_MKT}, ${h.deal}, ${h.client}, ${status}, ${U.marketer}, ${t + 86_400_000}, ${t})`;
  }
  await sql`INSERT INTO tasks (id, space_id, client_id, deal_id, kind, source, title, assignee_user_id, team_id, created_at)
            VALUES (${FX.handoffLive.task}, ${SPACE}, ${FX.handoffLive.client}, ${FX.handoffLive.deal}, 'handoff', 'handoff',
                    'Принять клиента', ${U.marketer}, ${TEAM_MKT}, ${t})`;

  // Мессенджер: канал оператора A, чат с клиентом B1 (чужой для A) и чат без клиента.
  await sql`INSERT INTO integrations (id, plugin_id, space_id, created_at, updated_at) VALUES ('int-msg', 'messenger.test', ${SPACE}, ${t}, ${t})`;
  await sql`INSERT INTO messenger_channels (id, integration_id, space_id, provider_channel_id, transport, owner_user_id, created_at, updated_at)
            VALUES ('ch-a', 'int-msg', ${SPACE}, 'prov-ch-a', 'whatsapp', ${U.opA}, ${t}, ${t})`;
  await sql`INSERT INTO messenger_chats (id, channel_id, chat_type, chat_id, client_id, created_at)
            VALUES ('chat-b1', 'ch-a', 'whatsapp', ${phoneOf('b', 1)}, ${clientOf('b', 1)}, ${t}),
                   ('chat-a1', 'ch-a', 'whatsapp', ${phoneOf('a', 1)}, ${clientOf('a', 1)}, ${t}),
                   ('chat-free', 'ch-a', 'whatsapp', '77099999999', NULL, ${t})`;
}
