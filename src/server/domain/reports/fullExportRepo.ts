// SQL полной выгрузки (R3b §2.5, D-055, D-264). Каждая таблица читается страницами по id (keyset, 1000 строк) внутри
// одной транзакции REPEATABLE READ: снимок один на весь архив, память не растёт. Каждая строка с данными клиентов —
// через scopeSql с разрешением чтения своей сущности; служебные колонки (хэши, HMAC, external_id, fields_patch, ключи
// идемпотентности) не выбираются вовсе. Время и деньги — как в БД (BIGINT), форматирует fullExport.ts.
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';

export const PAGE_ROWS = 1000;

/** Общие аргументы страницы: последний id предыдущей страницы (null — первая). */
export interface PageArgs {
  spaceId: string;
  after: string | null;
}

/** Лента: какие виды выгружаются (реестр) и какие несистемные поля видны роли (`obj:key`). */
export interface TimelineArgs {
  kinds: readonly string[];
  visibleRefs: readonly string[];
}

export const FULL_EXPORT_TABLES = [
  'users',
  'clients',
  'contacts',
  'client_phones',
  'client_sources',
  'consents',
  'cards',
  'calls',
  'bookings',
  'events',
  'deals',
  'handoffs',
  'tasks',
  'task_comments',
  'notes',
  'timeline',
  'messages',
] as const;
export type FullExportTable = (typeof FULL_EXPORT_TABLES)[number];

/**
 * Число строк каждой таблицы с теми же условиями охвата, что у страниц: для журнала и уведомления до первого байта.
 * Один запрос с подзапросами.
 */
export async function countFullExport(viewer: Viewer, sql: Sql, a: { spaceId: string } & TimelineArgs): Promise<Record<FullExportTable, number>> {
  const rows = await scoped(sql)<Record<FullExportTable, number>>`
    SELECT
      (SELECT count(*) FROM memberships m WHERE m.space_id = ${a.spaceId})::int AS users,
      (SELECT count(*) FROM clients cl WHERE ${scopeSql(viewer, 'client', 'client.read')})::int AS clients,
      (SELECT count(*) FROM contacts ct WHERE ${scopeSql(viewer, 'contact', 'client.read')})::int AS contacts,
      (SELECT count(*) FROM client_phones cp WHERE ${scopeSql(viewer, 'client_phone', 'client.read')})::int AS client_phones,
      (SELECT count(*) FROM client_sources s WHERE EXISTS (SELECT 1 FROM clients cl WHERE cl.id = s.client_id AND ${scopeSql(viewer, 'client', 'client.read')}))::int AS client_sources,
      (SELECT count(*) FROM consents cs WHERE EXISTS (SELECT 1 FROM clients cl WHERE cl.id = cs.client_id AND ${scopeSql(viewer, 'client', 'client.read')}))::int AS consents,
      (SELECT count(*) FROM cards c WHERE ${scopeSql(viewer, 'card', 'card.read')})::int AS cards,
      (SELECT count(*) FROM calls ca WHERE ${scopeSql(viewer, 'call', 'card.read')})::int AS calls,
      (SELECT count(*) FROM bookings b WHERE ${scopeSql(viewer, 'booking', 'booking.read')})::int AS bookings,
      (SELECT count(*) FROM events e WHERE ${scopeSql(viewer, 'event', 'booking.read')})::int AS events,
      (SELECT count(*) FROM deals d WHERE ${scopeSql(viewer, 'deal', 'deal.read')})::int AS deals,
      (SELECT count(*) FROM handoffs h WHERE ${scopeSql(viewer, 'handoff', 'handoff.read')})::int AS handoffs,
      (SELECT count(*) FROM tasks t WHERE ${scopeSql(viewer, 'task', 'task.read')})::int AS tasks,
      (SELECT count(*) FROM task_comments tc WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.id = tc.task_id AND ${scopeSql(viewer, 'task', 'task.read')}))::int AS task_comments,
      (SELECT count(*) FROM notes n WHERE ${scopeSql(viewer, 'note', 'card.read')})::int AS notes,
      (SELECT count(*) FROM client_events ev
        WHERE ${scopeSql(viewer, 'client_event', 'card.read')}
          AND ev.kind = ANY(${[...a.kinds]}::text[])
          AND NOT (ev.kind = 'field.changed' AND COALESCE(ev.data->>'sys', 'false') <> 'true'
                   AND NOT (((ev.data->>'obj') || ':' || (ev.data->>'field')) = ANY(${[...a.visibleRefs]}::text[]))))::int AS timeline,
      (SELECT count(*) FROM messenger_messages mm JOIN messenger_chats mc ON mc.id = mm.chat_ref
        WHERE ${scopeSql(viewer, 'messenger_chat', 'card.read')})::int AS messages`;
  return rows[0] as Record<FullExportTable, number>;
}

// ---------------------------------------------------------------------------
// Страницы таблиц
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  name: string;
  roleKey: string;
  membershipStatus: string;
  status: string;
  isAdmin: boolean;
}

/** Сотрудники пространства: без номера, пароля и сессий. */
export async function pageUsers(sql: Sql, a: PageArgs): Promise<UserRow[]> {
  return sql<UserRow>`
    SELECT u.id, u.name, m.role_key, m.status AS membership_status, u.status, u.is_admin
      FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.space_id = ${a.spaceId} AND (${a.after}::text IS NULL OR u.id > ${a.after}::text)
     ORDER BY u.id LIMIT ${PAGE_ROWS}`;
}

export interface ClientRow {
  id: string;
  kind: string;
  name: string;
  legalForm: string;
  orgId: string;
  region: string;
  address: string;
  email: string;
  website: string;
  custom: unknown;
  sourceKind: string;
  sourceKey: string;
  mergedIntoId: string | null;
  depersonalizedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export async function pageClients(viewer: Viewer, sql: Sql, a: PageArgs): Promise<ClientRow[]> {
  return scoped(sql)<ClientRow>`
    SELECT cl.id, cl.kind, cl.name, cl.legal_form, cl.org_id, cl.region, cl.address, cl.email, cl.website, cl.custom,
           cl.source_kind, cl.source_key, cl.merged_into_id, cl.depersonalized_at, cl.created_at, cl.updated_at
      FROM clients cl
     WHERE ${scopeSql(viewer, 'client', 'client.read')} AND (${a.after}::text IS NULL OR cl.id > ${a.after}::text)
     ORDER BY cl.id LIMIT ${PAGE_ROWS}`;
}

export interface ContactRow {
  id: string;
  clientId: string;
  name: string;
  position: string;
  isDecisionMaker: boolean;
  callHint: string;
  note: string;
  custom: unknown;
  createdAt: number;
  archivedAt: number | null;
}

export async function pageContacts(viewer: Viewer, sql: Sql, a: PageArgs): Promise<ContactRow[]> {
  return scoped(sql)<ContactRow>`
    SELECT ct.id, ct.client_id, ct.name, ct.position, ct.is_decision_maker, ct.call_hint, ct.note, ct.custom, ct.created_at, ct.archived_at
      FROM contacts ct
     WHERE ${scopeSql(viewer, 'contact', 'client.read')} AND (${a.after}::text IS NULL OR ct.id > ${a.after}::text)
     ORDER BY ct.id LIMIT ${PAGE_ROWS}`;
}

export interface PhoneRow {
  id: string;
  clientId: string;
  contactId: string | null;
  digits: string;
  ext: string;
  kind: string;
  isWorking: boolean;
  isPrimary: boolean;
  hasWhatsapp: string;
  createdAt: number;
}

export async function pagePhones(viewer: Viewer, sql: Sql, a: PageArgs): Promise<PhoneRow[]> {
  return scoped(sql)<PhoneRow>`
    SELECT cp.id, cp.client_id, cp.contact_id, cp.digits, cp.ext, cp.kind, cp.is_working, cp.is_primary, cp.has_whatsapp, cp.created_at
      FROM client_phones cp
     WHERE ${scopeSql(viewer, 'client_phone', 'client.read')} AND (${a.after}::text IS NULL OR cp.id > ${a.after}::text)
     ORDER BY cp.id LIMIT ${PAGE_ROWS}`;
}

export interface SourceRow {
  id: string;
  clientId: string;
  sourceKind: string;
  sourceKey: string;
  importId: string | null;
  firstSeenAt: number;
}

/** Источники клиента: без `external_id` (id записи у источника) и ключа приёма. */
export async function pageSources(viewer: Viewer, sql: Sql, a: PageArgs): Promise<SourceRow[]> {
  return scoped(sql)<SourceRow>`
    SELECT s.id, s.client_id, s.source_kind, s.source_key, s.import_id, s.first_seen_at
      FROM client_sources s
     WHERE EXISTS (SELECT 1 FROM clients cl WHERE cl.id = s.client_id AND ${scopeSql(viewer, 'client', 'client.read')})
       AND (${a.after}::text IS NULL OR s.id > ${a.after}::text)
     ORDER BY s.id LIMIT ${PAGE_ROWS}`;
}

export interface ConsentRow {
  id: string;
  clientId: string;
  kind: string;
  action: string;
  at: number;
  recordedBy: string | null;
  createdAt: number;
}

export async function pageConsents(viewer: Viewer, sql: Sql, a: PageArgs): Promise<ConsentRow[]> {
  return scoped(sql)<ConsentRow>`
    SELECT cs.id, cs.client_id, cs.kind, cs.action, cs.at, cs.recorded_by, cs.created_at
      FROM consents cs
     WHERE EXISTS (SELECT 1 FROM clients cl WHERE cl.id = cs.client_id AND ${scopeSql(viewer, 'client', 'client.read')})
       AND (${a.after}::text IS NULL OR cs.id > ${a.after}::text)
     ORDER BY cs.id LIMIT ${PAGE_ROWS}`;
}

export interface CardRow {
  id: string;
  clientId: string;
  ownerUserId: string | null;
  actingUserId: string | null;
  state: string;
  holdReason: string;
  attempts: number;
  nextCallAt: number | null;
  lpr: string;
  isTarget: string;
  lastOutcomeCode: string;
  lastOutcomeKind: string;
  lastOutcomeAt: number | null;
  closeReasonCode: string;
  closedAt: number | null;
  assignedAt: number | null;
  callsTotal: number;
  connectsTotal: number;
  noAnswerTotal: number;
  firstConnectAt: number | null;
  lastConnectAt: number | null;
  lastTouchAt: number | null;
  custom: unknown;
  createdAt: number;
  updatedAt: number;
}

export async function pageCards(viewer: Viewer, sql: Sql, a: PageArgs): Promise<CardRow[]> {
  return scoped(sql)<CardRow>`
    SELECT c.id, c.client_id, c.owner_user_id, c.acting_user_id, c.state, c.hold_reason, c.attempts, c.next_call_at, c.lpr, c.is_target,
           c.last_outcome_code, c.last_outcome_kind, c.last_outcome_at, c.close_reason_code, c.closed_at, c.assigned_at,
           c.calls_total, c.connects_total, c.no_answer_total, c.first_connect_at, c.last_connect_at, c.last_touch_at,
           c.custom, c.created_at, c.updated_at
      FROM cards c
     WHERE ${scopeSql(viewer, 'card', 'card.read')} AND (${a.after}::text IS NULL OR c.id > ${a.after}::text)
     ORDER BY c.id LIMIT ${PAGE_ROWS}`;
}

export interface CallRow {
  id: string;
  cardId: string;
  clientId: string;
  userId: string | null;
  direction: string;
  via: string;
  phoneDigits: string;
  outcomeCode: string;
  outcomeKind: string;
  reasonCode: string;
  note: string;
  lpr: string;
  callbackAt: number | null;
  applied: string;
  factReason: string;
  occurredAt: number;
  durationSec: number | null;
  durationSource: string;
}

/** Звонки: без `fields_patch` (в нём бывают значения скрытых полей; текущие значения — в cards.csv по проекции). */
export async function pageCalls(viewer: Viewer, sql: Sql, a: PageArgs): Promise<CallRow[]> {
  return scoped(sql)<CallRow>`
    SELECT ca.id, ca.card_id, ca.client_id, ca.user_id, ca.direction, ca.via, ca.phone_digits, ca.outcome_code, ca.outcome_kind,
           ca.reason_code, ca.note, ca.lpr, ca.callback_at, ca.applied, ca.fact_reason, ca.occurred_at, ca.duration_sec, ca.duration_source
      FROM calls ca
     WHERE ${scopeSql(viewer, 'call', 'card.read')} AND (${a.after}::text IS NULL OR ca.id > ${a.after}::text)
     ORDER BY ca.id LIMIT ${PAGE_ROWS}`;
}

export interface BookingRow {
  id: string;
  kind: string;
  eventTypeKey: string;
  eventId: string | null;
  resourceId: string | null;
  clientId: string;
  cardId: string;
  dealId: string | null;
  contactId: string | null;
  bookingDate: string;
  startTime: string;
  durationMin: number;
  directionKey: string;
  isReserve: boolean;
  status: string;
  cancelReason: string;
  via: string;
  bookedByUserId: string | null;
  responsibleUserId: string | null;
  movedFromId: string | null;
  movedToId: string | null;
  custom: unknown;
  createdAt: number;
}

export async function pageBookings(viewer: Viewer, sql: Sql, a: PageArgs): Promise<BookingRow[]> {
  return scoped(sql)<BookingRow>`
    SELECT b.id, b.kind, b.event_type_key, b.event_id, b.resource_id, b.client_id, b.card_id, b.deal_id, b.contact_id, b.booking_date,
           b.start_time, b.duration_min, b.direction_key, b.is_reserve, b.status, b.cancel_reason, b.via, b.booked_by_user_id,
           b.responsible_user_id, b.moved_from_id, b.moved_to_id, b.custom, b.created_at
      FROM bookings b
     WHERE ${scopeSql(viewer, 'booking', 'booking.read')} AND (${a.after}::text IS NULL OR b.id > ${a.after}::text)
     ORDER BY b.id LIMIT ${PAGE_ROWS}`;
}

export interface EventRow {
  id: string;
  seriesId: string | null;
  eventTypeKey: string;
  eventDate: string;
  startTime: string;
  durationMin: number;
  location: string;
  format: string;
  capacity: number;
  status: string;
  createdAt: number;
}

export async function pageEvents(viewer: Viewer, sql: Sql, a: PageArgs): Promise<EventRow[]> {
  return scoped(sql)<EventRow>`
    SELECT e.id, e.series_id, e.event_type_key, e.event_date, e.start_time, e.duration_min, e.location, e.format, e.capacity, e.status, e.created_at
      FROM events e
     WHERE ${scopeSql(viewer, 'event', 'booking.read')} AND (${a.after}::text IS NULL OR e.id > ${a.after}::text)
     ORDER BY e.id LIMIT ${PAGE_ROWS}`;
}

export interface DealRow {
  id: string;
  pipelineKey: string;
  stageKey: string;
  status: string;
  clientId: string;
  cardId: string;
  ownerUserId: string | null;
  serviceTypeKey: string;
  amountKzt: number;
  wonAt: number | null;
  lostAt: number | null;
  lostReasonCode: string;
  lostReasonText: string;
  needsRebook: boolean;
  stageChangedAt: number;
  custom: unknown;
  createdBy: string | null;
  createdAt: number;
}

export async function pageDeals(viewer: Viewer, sql: Sql, a: PageArgs): Promise<DealRow[]> {
  return scoped(sql)<DealRow>`
    SELECT d.id, d.pipeline_key, d.stage_key, d.status, d.client_id, d.card_id, d.owner_user_id, d.service_type_key, d.amount_kzt,
           d.won_at, d.lost_at, d.lost_reason_code, d.lost_reason_text, d.needs_rebook, d.stage_changed_at, d.custom, d.created_by, d.created_at
      FROM deals d
     WHERE ${scopeSql(viewer, 'deal', 'deal.read')} AND (${a.after}::text IS NULL OR d.id > ${a.after}::text)
     ORDER BY d.id LIMIT ${PAGE_ROWS}`;
}

export interface HandoffRow {
  id: string;
  dealId: string;
  clientId: string;
  status: string;
  teamId: string;
  assigneeUserId: string | null;
  dueAt: number;
  acceptedAt: number | null;
  acceptedBy: string | null;
  declinedReason: string;
  createdAt: number;
}

export async function pageHandoffs(viewer: Viewer, sql: Sql, a: PageArgs): Promise<HandoffRow[]> {
  return scoped(sql)<HandoffRow>`
    SELECT h.id, h.deal_id, h.client_id, h.status, h.team_id, h.assignee_user_id, h.due_at, h.accepted_at, h.accepted_by, h.declined_reason, h.created_at
      FROM handoffs h
     WHERE ${scopeSql(viewer, 'handoff', 'handoff.read')} AND (${a.after}::text IS NULL OR h.id > ${a.after}::text)
     ORDER BY h.id LIMIT ${PAGE_ROWS}`;
}

export interface TaskRow {
  id: string;
  clientId: string;
  dealId: string | null;
  kind: string;
  source: string;
  title: string;
  dueAt: number | null;
  assigneeUserId: string | null;
  teamId: string | null;
  status: string;
  createdBy: string | null;
  doneAt: number | null;
  createdAt: number;
}

export async function pageTasks(viewer: Viewer, sql: Sql, a: PageArgs): Promise<TaskRow[]> {
  return scoped(sql)<TaskRow>`
    SELECT t.id, t.client_id, t.deal_id, t.kind, t.source, t.title, t.due_at, t.assignee_user_id, t.team_id, t.status, t.created_by, t.done_at, t.created_at
      FROM tasks t
     WHERE ${scopeSql(viewer, 'task', 'task.read')} AND (${a.after}::text IS NULL OR t.id > ${a.after}::text)
     ORDER BY t.id LIMIT ${PAGE_ROWS}`;
}

export interface TaskCommentRow {
  id: string;
  taskId: string;
  authorId: string | null;
  body: string;
  createdAt: number;
}

export async function pageTaskComments(viewer: Viewer, sql: Sql, a: PageArgs): Promise<TaskCommentRow[]> {
  return scoped(sql)<TaskCommentRow>`
    SELECT tc.id, tc.task_id, tc.author_id, tc.body, tc.created_at
      FROM task_comments tc
     WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.id = tc.task_id AND ${scopeSql(viewer, 'task', 'task.read')})
       AND (${a.after}::text IS NULL OR tc.id > ${a.after}::text)
     ORDER BY tc.id LIMIT ${PAGE_ROWS}`;
}

export interface NoteRow {
  id: string;
  clientId: string;
  dealId: string | null;
  authorId: string | null;
  body: string;
  pinned: boolean;
  editedAt: number | null;
  createdAt: number;
}

export async function pageNotes(viewer: Viewer, sql: Sql, a: PageArgs): Promise<NoteRow[]> {
  return scoped(sql)<NoteRow>`
    SELECT n.id, n.client_id, n.deal_id, n.author_id, n.body, n.pinned, n.edited_at, n.created_at
      FROM notes n
     WHERE ${scopeSql(viewer, 'note', 'card.read')} AND (${a.after}::text IS NULL OR n.id > ${a.after}::text)
     ORDER BY n.id LIMIT ${PAGE_ROWS}`;
}

export interface TimelineRow {
  id: string;
  clientId: string;
  kind: string;
  actorId: string | null;
  at: number;
  dealId: string | null;
  refType: string;
  refId: string;
  data: unknown;
}

/** Лента: виды из реестра; «поле было → стало» скрытого для роли поля не выбирается (как в ленте карточки). */
export async function pageTimeline(viewer: Viewer, sql: Sql, a: PageArgs & TimelineArgs): Promise<TimelineRow[]> {
  return scoped(sql)<TimelineRow>`
    SELECT ev.id, ev.client_id, ev.kind, ev.actor_id, ev.at, ev.deal_id, ev.ref_type, ev.ref_id, ev.data
      FROM client_events ev
     WHERE ${scopeSql(viewer, 'client_event', 'card.read')}
       AND ev.kind = ANY(${[...a.kinds]}::text[])
       AND NOT (ev.kind = 'field.changed' AND COALESCE(ev.data->>'sys', 'false') <> 'true'
                AND NOT (((ev.data->>'obj') || ':' || (ev.data->>'field')) = ANY(${[...a.visibleRefs]}::text[])))
       AND (${a.after}::text IS NULL OR ev.id > ${a.after}::text)
     ORDER BY ev.id LIMIT ${PAGE_ROWS}`;
}

export interface MessageRow {
  id: string;
  chatRef: string;
  clientId: string | null;
  direction: string;
  msgType: string;
  body: string | null;
  hasAttachment: boolean;
  status: string | null;
  authorUserId: string | null;
  isEdited: boolean;
  isDeleted: boolean;
  sentAt: number;
}

/** Сообщения мессенджера по охвату чата; текст удалённого сообщения не выгружается. */
export async function pageMessages(viewer: Viewer, sql: Sql, a: PageArgs): Promise<MessageRow[]> {
  return scoped(sql)<MessageRow>`
    SELECT mm.id, mm.chat_ref, mc.client_id, mm.direction, mm.msg_type, CASE WHEN mm.is_deleted THEN NULL ELSE mm.body END AS body,
           mm.has_attachment, mm.status, mm.author_user_id, mm.is_edited, mm.is_deleted, mm.sent_at
      FROM messenger_messages mm JOIN messenger_chats mc ON mc.id = mm.chat_ref
     WHERE ${scopeSql(viewer, 'messenger_chat', 'card.read')} AND (${a.after}::text IS NULL OR mm.id > ${a.after}::text)
     ORDER BY mm.id LIMIT ${PAGE_ROWS}`;
}

// ---------------------------------------------------------------------------
// Получатели уведомления
// ---------------------------------------------------------------------------

/** Активные администраторы установки (уведомление о полной выгрузке, PROCESS 8.6). */
export async function selectActiveAdmins(sql: Sql): Promise<string[]> {
  const rows = await sql<{ id: string }>`SELECT id FROM users WHERE is_admin AND status = 'active' ORDER BY id`;
  return rows.map((r) => r.id);
}
