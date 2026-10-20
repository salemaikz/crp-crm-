// SQL сида. Все вставки — пачкой через jsonb_to_recordset и `ON CONFLICT DO NOTHING RETURNING`: возвращается
// число действительно добавленных строк, повторный запуск даёт 0. Ключи JSON — snake_case, как колонки.
// Файл лежит рядом со скриптом, а не в домене: сид — разовая загрузка стенда, у домена нет пакетной записи,
// а скриптам импорт репозиториев домена запрещён (eslint). Дублирования ограничений нет: их проверяет сама схема.
import { jsonParam } from '../../src/server/platform/db/core';
import type { Sql } from '../../src/server/platform/db';

type Rows = readonly Record<string, unknown>[];
const j = (rows: Rows) => jsonParam(rows);

export async function insertUsers(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO users (id, phone_digits, name, password_hash, is_admin, locale, status, created_at)
    SELECT t.id, t.phone_digits, t.name, t.password_hash, t.is_admin, 'ru', 'active', t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, phone_digits text, name text, password_hash text, is_admin boolean, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertMemberships(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO memberships (user_id, space_id, role_key, team_id, in_distribution, status, created_at, updated_at)
    SELECT t.user_id, t.space_id, t.role_key, t.team_id, t.in_distribution, 'active', t.created_at, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(user_id text, space_id text, role_key text, team_id text, in_distribution boolean, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING user_id`
  ).length;
}

/** Руководитель команды — только если он ещё не назначен. */
export async function setTeamLead(sql: Sql, teamId: string, userId: string): Promise<number> {
  return (await sql`UPDATE teams SET lead_user_id = ${userId} WHERE id = ${teamId} AND lead_user_id IS NULL RETURNING id`).length;
}

export async function insertResources(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO resources (id, space_id, user_id, directions, slot_min, capacity, auto_assign, active, sort, created_at, updated_at)
    SELECT t.id, t.space_id, t.user_id, ARRAY(SELECT jsonb_array_elements_text(t.directions)), t.slot_min, 1, TRUE, TRUE, t.sort, t.created_at, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, space_id text, user_id text, directions jsonb, slot_min int, sort int, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertSchedule(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO resource_schedule (id, resource_id, weekday, start_time, end_time)
    SELECT t.id, t.resource_id, t.weekday, t.start_time, t.end_time
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, resource_id text, weekday int, start_time text, end_time text)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertExceptions(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO resource_exceptions (id, resource_id, day, kind, windows, created_by, created_at)
    SELECT t.id, t.resource_id, t.day, 'off', '[]'::jsonb, NULL, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, resource_id text, day text, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertImports(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO imports (id, space_id, file_name, file_sha256, profile_key, status, report, created_by, created_at, applied_at)
    SELECT t.id, t.space_id, t.file_name, t.file_sha256, t.profile_key, 'applied', t.report, NULL, t.created_at, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, space_id text, file_name text, file_sha256 text, profile_key text, report jsonb, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertClients(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO clients (id, kind, name, name_norm, legal_form, org_id, iin_hmac, region, address, email, website, custom, search_norm,
                         source_kind, source_key, created_at, updated_at)
    SELECT t.id, t.kind, t.name, t.name_norm, t.legal_form, '', NULL, t.region, t.address, '', '', t.custom, t.search_norm,
           'import', t.source_key, t.created_at, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, kind text, name text, name_norm text, legal_form text, region text, address text,
                                               custom jsonb, search_norm text, source_key text, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertContacts(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO contacts (id, client_id, name, position, is_decision_maker, call_hint, note, custom, created_at)
    SELECT t.id, t.client_id, t.name, t.position, t.is_decision_maker, '', '', '{}'::jsonb, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, client_id text, name text, position text, is_decision_maker boolean, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertPhones(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO client_phones (id, client_id, contact_id, digits, ext, kind, is_working, is_primary, has_whatsapp, created_at)
    SELECT t.id, t.client_id, t.contact_id, t.digits, '', 'mobile', t.is_working, t.is_primary, t.has_whatsapp, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, client_id text, contact_id text, digits text, is_working boolean, is_primary boolean,
                                               has_whatsapp text, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertClientSources(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO client_sources (id, client_id, source_kind, source_key, ingest_key_id, import_id, external_id, first_seen_at)
    SELECT t.id, t.client_id, 'import', t.source_key, NULL, t.import_id, NULL, t.first_seen_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, client_id text, source_key text, import_id text, first_seen_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertCards(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO cards (id, space_id, client_id, owner_user_id, state, attempts, next_call_at, return_at, lpr, is_target,
                       last_outcome_code, last_outcome_kind, last_outcome_at, close_reason_code, closed_at, assigned_at, touched_in_crm,
                       calls_total, connects_total, no_answer_total, first_connect_at, last_connect_at, last_touch_at, created_at, updated_at)
    SELECT t.id, t.space_id, t.client_id, t.owner_user_id, t.state, t.attempts, t.next_call_at, t.return_at, t.lpr, t.is_target,
           t.last_outcome_code, t.last_outcome_kind, t.last_outcome_at, t.close_reason_code, t.closed_at, t.assigned_at, t.touched_in_crm,
           t.calls_total, t.connects_total, t.no_answer_total, t.first_connect_at, t.last_connect_at, t.last_touch_at, t.created_at, t.updated_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, space_id text, client_id text, owner_user_id text, state text, attempts int,
                                               next_call_at bigint, return_at bigint, lpr text, is_target text, last_outcome_code text,
                                               last_outcome_kind text, last_outcome_at bigint, close_reason_code text, closed_at bigint,
                                               assigned_at bigint, touched_in_crm boolean, calls_total int, connects_total int,
                                               no_answer_total int, first_connect_at bigint, last_connect_at bigint, last_touch_at bigint,
                                               created_at bigint, updated_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertCalls(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO calls (id, space_id, card_id, client_id, user_id, owner_user_id_at_call, direction, via, phone_digits, outcome_code, outcome_kind,
                       reason_code, note, lpr, callback_at, fields_patch, applied, fact_reason, occurred_at, received_at, duration_sec,
                       duration_source, config_rev)
    SELECT t.id, t.space_id, t.card_id, t.client_id, t.user_id, t.user_id, 'out', 'ui', t.phone_digits, t.outcome_code, t.outcome_kind,
           t.reason_code, '', t.lpr, t.callback_at, '{}'::jsonb, 'applied', '', t.occurred_at, t.occurred_at + 1000, t.duration_sec,
           CASE WHEN t.duration_sec IS NULL THEN 'none' ELSE 'manual_estimate' END, t.config_rev
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, space_id text, card_id text, client_id text, user_id text, phone_digits text,
                                               outcome_code text, outcome_kind text, reason_code text, lpr text, callback_at bigint,
                                               occurred_at bigint, duration_sec int, config_rev int)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertAssignLog(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, run_id, day, actor_id, created_at)
    SELECT t.id, t.space_id, t.card_id, NULL, t.to_user_id, 'auto', TRUE, t.run_id, t.day, NULL, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, space_id text, card_id text, to_user_id text, run_id text, day text, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertClientEvents(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
    SELECT t.id, t.client_id, t.space_id, NULL, t.kind, t.actor_id, t.at, t.ref_type, t.ref_id, t.data
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, client_id text, space_id text, kind text, actor_id text, at bigint, ref_type text,
                                               ref_id text, data jsonb)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertStopList(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO stop_list (phone_hmac, reason_code, source, created_by, created_at)
    SELECT t.phone_hmac, t.reason_code, 'outcome', NULL, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(phone_hmac text, reason_code text, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING phone_hmac`
  ).length;
}

export async function insertNotes(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO notes (id, client_id, space_id, deal_id, author_id, body, pinned, created_at)
    SELECT t.id, t.client_id, t.space_id, NULL, t.author_id, t.body, t.pinned, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, client_id text, space_id text, author_id text, body text, pinned boolean, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

/** Серия мероприятий: если в пресете её нет (другая накладка) — стенд заводит свою. */
export async function insertSeries(sql: Sql, r: { id: string; spaceId: string; eventTypeKey: string; weekday: number; startTime: string; durationMin: number; capacity: number; at: number }): Promise<number> {
  return (
    await sql`
    INSERT INTO event_series (id, space_id, event_type_key, weekday, start_time, duration_min, location, format, capacity, active, created_at, updated_at)
    VALUES (${r.id}, ${r.spaceId}, ${r.eventTypeKey}, ${r.weekday}, ${r.startTime}, ${r.durationMin}, '', 'offline', ${r.capacity}, TRUE, ${r.at}, ${r.at})
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertEvents(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO events (id, space_id, series_id, event_type_key, event_date, start_time, starts_at, duration_min, location, format, capacity,
                        status, occurrence_key, touched, created_at, updated_at)
    SELECT t.id, t.space_id, t.series_id, t.event_type_key, t.event_date, t.start_time, t.starts_at, t.duration_min, '', 'offline', t.capacity,
           'scheduled', t.occurrence_key, FALSE, t.created_at, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, space_id text, series_id text, event_type_key text, event_date text, start_time text,
                                               starts_at bigint, duration_min int, capacity int, occurrence_key text, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertDuty(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO event_duty (event_id, user_id, created_by, created_at)
    SELECT t.event_id, t.user_id, NULL, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(event_id text, user_id text, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING event_id`
  ).length;
}

export async function insertDeals(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt, won_at,
                       lost_at, stage_changed_at, request_id, created_by, created_at, updated_at)
    SELECT t.id, t.space_id, t.pipeline_key, t.stage_key, t.status, t.client_id, t.card_id, t.owner_user_id, t.service_type_key, t.amount_kzt,
           t.won_at, NULL, t.stage_changed_at, t.request_id, NULL, t.created_at, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, space_id text, pipeline_key text, stage_key text, status text, client_id text,
                                               card_id text, owner_user_id text, service_type_key text, amount_kzt bigint, won_at bigint,
                                               stage_changed_at bigint, request_id text, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertBookings(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, resource_id, client_id, card_id, deal_id, booking_date, start_time, starts_at,
                          duration_min, direction_key, status, via, booked_by_user_id, responsible_user_id, request_id, created_at, updated_at)
    SELECT t.id, t.space_id, t.kind, t.event_type_key, t.event_id, t.resource_id, t.client_id, t.card_id, t.deal_id, t.booking_date, t.start_time,
           t.starts_at, t.duration_min, t.direction_key, t.status, 'ui', t.user_id, t.user_id, t.request_id, t.created_at, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, space_id text, kind text, event_type_key text, event_id text, resource_id text,
                                               client_id text, card_id text, deal_id text, booking_date text, start_time text, starts_at bigint,
                                               duration_min int, direction_key text, status text, user_id text, request_id text, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertBookingHistory(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO booking_history (id, booking_id, action, from_status, to_status, actor_id, meta, created_at)
    SELECT t.id, t.booking_id, t.action, t.from_status, t.to_status, t.actor_id, '{}'::jsonb, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, booking_id text, action text, from_status text, to_status text, actor_id text, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertHandoffs(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO handoffs (id, space_id_from, space_id_to, team_id, deal_id, client_id, status, assignee_user_id, due_at, accepted_at, accepted_by, created_at)
    SELECT t.id, t.space_id, t.space_id, t.team_id, t.deal_id, t.client_id, t.status, t.assignee_user_id, t.due_at, t.accepted_at, t.accepted_by, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, space_id text, team_id text, deal_id text, client_id text, status text, assignee_user_id text,
                                               due_at bigint, accepted_at bigint, accepted_by text, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}

export async function insertTasks(sql: Sql, rows: Rows): Promise<number> {
  return (
    await sql`
    INSERT INTO tasks (id, space_id, client_id, deal_id, kind, source, title, due_at, assignee_user_id, team_id, status, source_key, created_by, created_at)
    SELECT t.id, t.space_id, t.client_id, t.deal_id, t.kind, t.source, t.title, t.due_at, t.assignee_user_id, t.team_id, 'open', t.source_key, NULL, t.created_at
      FROM jsonb_to_recordset(${j(rows)}) AS t(id text, space_id text, client_id text, deal_id text, kind text, source text, title text,
                                               due_at bigint, assignee_user_id text, team_id text, source_key text, created_at bigint)
    ON CONFLICT DO NOTHING RETURNING id`
  ).length;
}
