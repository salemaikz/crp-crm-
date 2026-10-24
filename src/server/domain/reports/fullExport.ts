// Полная выгрузка (R3b §2.5, D-055, D-264). Шаг 1: повторный пароль → одноразовый билет на 60 с. Шаг 2: билет гасится,
// журнал и уведомления пишутся в одной транзакции до первого байта, затем ZIP с CSV по таблицам и настройками уходит
// потоком из одной транзакции REPEATABLE READ READ ONLY. Работает при любой лицензии и у роли «только чтение»
// (разрешение вида export, D-054). Администратор без роли — 403: у него нет `data.export_all` и пространства.
import { fields, time } from '@crm/core';
import pkg from '../../../../package.json';
import { ForbiddenError, NotFoundError, can, scopeOf, type Viewer } from '@/server/access';
import { fieldViewer, loadClientsConfig } from '@/server/domain/clients';
import { notifyRoles } from '@/server/domain/notify';
import { EVENT_KINDS } from '@/server/domain/timeline';
import { pickData } from '@/server/domain/timeline/kinds';
import { getActiveConfig } from '@/server/platform/config/active';
import { verifyUserPassword } from '@/server/platform/auth/service';
import { getDb, newId, type Db, type Sql } from '@/server/platform/db';
import { createZipWriter, toExcelCsvLines, type CsvCellValue, type ZipWriter } from '@/server/platform/files';
import { rateLimit } from '@/server/platform/ratelimit';
import { ExportLimitError, PasswordInvalidError } from './exportErrors';
import { writeExportLogIn, writeFullExportDone } from './exportLog';
import { countFullExportsSince, type FullExportCounts } from './exportRepo';
import * as repo from './fullExportRepo';
import type { FullExportTable } from './fullExportRepo';
import type { IssueFullExportTicket, StreamFullExport } from './reportTypes';
import { consumeTicket, heldByOther, issueTicket, ticketValid } from './tickets';

/** Завершённых полных выгрузок сотрудника за местные сутки (D-264, D-294; вопрос владельцу §14 п. 2). */
export const FULL_EXPORTS_PER_DAY = 3;
/**
 * Начатых за местные сутки, считая оборванные (D-294): обрыв связи не съедает лимит, но и не даёт бесконечных
 * попыток. Каждое начало и так пишется в журнал и уведомляет директора, РОП и администраторов.
 */
export const FULL_EXPORT_STARTS_PER_DAY = 10;
/** Попыток пароля за окно. */
export const PASSWORD_ATTEMPTS = 5;
export const PASSWORD_WINDOW_MS = 15 * 60_000;
/** Вся выгрузка не дольше: зависший получатель не держит транзакцию и семафор вечно. */
export const FULL_EXPORT_DEADLINE_MS = 20 * 60_000;

export const NOTIFY_KIND_FULL_EXPORT = 'export_full_done';

// ---------------------------------------------------------------------------
// Доступ и семафор
// ---------------------------------------------------------------------------

/** Разрешение `data.export_all` с охватом пространства и само пространство; иначе 403 раздела. */
function requireFullExport(viewer: Viewer): string {
  const scope = scopeOf(viewer, 'data.export_all');
  if (viewer.spaceId === null || !can(viewer, 'data.export_all') || (scope !== 'space' && scope !== 'all')) throw new ForbiddenError();
  return viewer.spaceId;
}

type Gate = { running: boolean };
const g = globalThis as typeof globalThis & { __crmFullExportGate?: Gate };
const gate: Gate = (g.__crmFullExportGate ??= { running: false });

/** Свободно ли: никто не выгружает и нет брони чужим живым билетом (D-294). */
function freeFor(userId: string, now: number): boolean {
  return !gate.running && !heldByOther(userId, now);
}

function acquire(userId: string, now: number): boolean {
  if (!freeFor(userId, now)) return false;
  gate.running = true;
  return true;
}

function release(): void {
  gate.running = false;
}

/** Только тесты: идёт ли выгрузка. */
export function fullExportRunning(): boolean {
  return gate.running;
}

async function exportsToday(sql: Sql, viewer: Viewer): Promise<FullExportCounts> {
  return countFullExportsSince(sql, { userId: viewer.userId, since: time.fromLocalTime(viewer.today, '00:00', viewer.timeZone) });
}

/** Лимиты суток (D-294): завершённых — 3, начатых (с оборванными) — 10. Оба исчерпания — один код `export_limit`. */
function underLimits(c: FullExportCounts): boolean {
  return c.completed < FULL_EXPORTS_PER_DAY && c.started < FULL_EXPORT_STARTS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Шаг 1: пароль → билет
// ---------------------------------------------------------------------------

export const issueFullExportTicket: IssueFullExportTicket = async (viewer, input) => {
  requireFullExport(viewer);
  const rl = rateLimit(`fullexport:pw:${viewer.userId}`, PASSWORD_ATTEMPTS, PASSWORD_WINDOW_MS, viewer.now);
  if (!rl.ok) throw new ExportLimitError('rate_limited', Math.max(1, Math.ceil(rl.retryAfterMs / 1000)));
  // неверный пароль: 403 без записи в журнал; хеш не покидает платформу
  if (!(await verifyUserPassword(viewer.userId, input.password))) throw new PasswordInvalidError();
  const db = await getDb();
  if (!underLimits(await exportsToday(db.sql, viewer))) throw new ExportLimitError('export_limit');
  // проверка и выдача — без await между ними: живой билет и есть бронь на 60 с (D-294)
  if (!freeFor(viewer.userId, viewer.now)) throw new ExportLimitError('busy');
  return issueTicket(viewer.userId, viewer.now);
};

// ---------------------------------------------------------------------------
// Шаг 2: билет → журнал, уведомления → поток ZIP
// ---------------------------------------------------------------------------

type Ctx = {
  spaceId: string;
  spaceKey: string;
  timeZone: string;
  fv: fields.FieldViewer;
  defs: readonly fields.FieldDef[];
  kinds: string[];
  visibleRefs: string[];
  configFiles: { name: string; body: unknown }[];
  recipientRoles: string[];
};

async function contextOf(viewer: Viewer, spaceId: string): Promise<Ctx> {
  const [cfg, active] = await Promise.all([loadClientsConfig(viewer), getActiveConfig()]);
  const fv = fieldViewer(viewer, cfg);
  const entry = Object.entries(active.spaces).find(([, s]) => s.spaceId === spaceId);
  const spaceKey = entry && /^[a-z0-9_-]{1,64}$/.test(entry[0]) ? entry[0] : 'space';
  const configFiles: Ctx['configFiles'] = [{ name: 'config/global.json', body: { area: 'global', rev: active.global.rev, doc: active.global.doc } }];
  if (entry) configFiles.push({ name: `config/space-${spaceKey}.json`, body: { area: 'space', key: entry[0], rev: entry[1].rev, doc: entry[1].doc } });
  // кому уведомление: роли, которые дают полную выгрузку (PROCESS 8.6: директор, РОП), и все администраторы
  const recipientRoles = active.global.doc.roles.filter((r) => !r.archived && r.grants.some((x) => x.perm === 'data.export_all')).map((r) => r.key);
  return {
    spaceId,
    spaceKey,
    timeZone: viewer.timeZone,
    fv,
    defs: cfg.fields,
    kinds: Object.keys(EVENT_KINDS),
    visibleRefs: fields.visibleFieldRefs(fv, cfg.fields),
    configFiles,
    recipientRoles,
  };
}

/** Местное «YYYY-MM-DD HH:MM». Смещение пояса кэшируется по часу: формат миллиона строк не упирается в Intl. */
function stampFormatter(timeZone: string): (ms: number | null) => string {
  const offsets = new Map<number, number>();
  return (ms) => {
    if (ms === null || !Number.isFinite(ms)) return '';
    const hour = Math.floor(ms / 3_600_000);
    let off = offsets.get(hour);
    if (off === undefined) {
      off = time.utcOffsetMs(ms, timeZone);
      if (offsets.size > 10_000) offsets.clear();
      offsets.set(hour, off);
    }
    return new Date(ms + off).toISOString().slice(0, 16).replace('T', ' ');
  };
}

const flag = (b: boolean): number => (b ? 1 : 0);

type Table<R extends { id: string }> = {
  name: FullExportTable;
  header: string[];
  page: (sql: Sql, after: string | null) => Promise<R[]>;
  row: (r: R) => CsvCellValue[];
};

function tablesOf(viewer: Viewer, ctx: Ctx): Table<{ id: string }>[] {
  const at = stampFormatter(ctx.timeZone);
  const a = (after: string | null): repo.PageArgs => ({ spaceId: ctx.spaceId, after });
  const custom = (obj: fields.FieldObject, v: unknown): string => {
    const values = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as fields.CustomValues) : {};
    const visible = fields.projectValues(ctx.fv, obj, ctx.defs, values);
    return Object.keys(visible).length === 0 ? '' : JSON.stringify(visible);
  };
  const t = <R extends { id: string }>(x: Table<R>): Table<{ id: string }> => x as unknown as Table<{ id: string }>;
  return [
    t<repo.UserRow>({
      name: 'users',
      header: ['id', 'name', 'role_key', 'membership_status', 'status', 'is_admin'],
      page: (sql, after) => repo.pageUsers(sql, a(after)),
      row: (r) => [r.id, r.name, r.roleKey, r.membershipStatus, r.status, flag(r.isAdmin)],
    }),
    t<repo.ClientRow>({
      name: 'clients',
      header: ['id', 'kind', 'name', 'legal_form', 'org_id', 'region', 'address', 'email', 'website', 'custom', 'source_kind', 'source_key', 'merged_into_id', 'depersonalized_at', 'created_at', 'updated_at'],
      page: (sql, after) => repo.pageClients(viewer, sql, a(after)),
      row: (r) => [
        r.id,
        r.kind,
        r.name,
        r.legalForm,
        r.orgId,
        r.region,
        r.address,
        r.email,
        r.website,
        custom('client', r.custom),
        r.sourceKind,
        r.sourceKey,
        r.mergedIntoId,
        at(r.depersonalizedAt),
        at(r.createdAt),
        at(r.updatedAt),
      ],
    }),
    t<repo.ContactRow>({
      name: 'contacts',
      header: ['id', 'client_id', 'name', 'position', 'is_decision_maker', 'call_hint', 'note', 'custom', 'created_at', 'archived_at'],
      page: (sql, after) => repo.pageContacts(viewer, sql, a(after)),
      row: (r) => [r.id, r.clientId, r.name, r.position, flag(r.isDecisionMaker), r.callHint, r.note, custom('contact', r.custom), at(r.createdAt), at(r.archivedAt)],
    }),
    t<repo.PhoneRow>({
      name: 'client_phones',
      header: ['id', 'client_id', 'contact_id', 'phone_digits', 'ext', 'kind', 'is_working', 'is_primary', 'has_whatsapp', 'created_at'],
      page: (sql, after) => repo.pagePhones(viewer, sql, a(after)),
      row: (r) => [r.id, r.clientId, r.contactId, r.digits, r.ext, r.kind, flag(r.isWorking), flag(r.isPrimary), r.hasWhatsapp, at(r.createdAt)],
    }),
    t<repo.SourceRow>({
      name: 'client_sources',
      header: ['id', 'client_id', 'source_kind', 'source_key', 'import_id', 'first_seen_at'],
      page: (sql, after) => repo.pageSources(viewer, sql, a(after)),
      row: (r) => [r.id, r.clientId, r.sourceKind, r.sourceKey, r.importId, at(r.firstSeenAt)],
    }),
    t<repo.ConsentRow>({
      name: 'consents',
      header: ['id', 'client_id', 'kind', 'action', 'at', 'recorded_by', 'created_at'],
      page: (sql, after) => repo.pageConsents(viewer, sql, a(after)),
      row: (r) => [r.id, r.clientId, r.kind, r.action, at(r.at), r.recordedBy, at(r.createdAt)],
    }),
    t<repo.CardRow>({
      name: 'cards',
      header: [
        'id', 'client_id', 'owner_user_id', 'acting_user_id', 'state', 'hold_reason', 'attempts', 'next_call_at', 'lpr', 'is_target',
        'last_outcome_code', 'last_outcome_kind', 'last_outcome_at', 'close_reason_code', 'closed_at', 'assigned_at',
        'calls_total', 'connects_total', 'no_answer_total', 'first_connect_at', 'last_connect_at', 'last_touch_at', 'custom', 'created_at', 'updated_at',
      ],
      page: (sql, after) => repo.pageCards(viewer, sql, a(after)),
      row: (r) => [
        r.id, r.clientId, r.ownerUserId, r.actingUserId, r.state, r.holdReason, r.attempts, at(r.nextCallAt), r.lpr, r.isTarget,
        r.lastOutcomeCode, r.lastOutcomeKind, at(r.lastOutcomeAt), r.closeReasonCode, at(r.closedAt), at(r.assignedAt),
        r.callsTotal, r.connectsTotal, r.noAnswerTotal, at(r.firstConnectAt), at(r.lastConnectAt), at(r.lastTouchAt), custom('card', r.custom), at(r.createdAt), at(r.updatedAt),
      ],
    }),
    t<repo.CallRow>({
      name: 'calls',
      header: ['id', 'card_id', 'client_id', 'user_id', 'direction', 'via', 'phone_digits', 'outcome_code', 'outcome_kind', 'reason_code', 'note', 'lpr', 'callback_at', 'applied', 'fact_reason', 'occurred_at', 'duration_sec', 'duration_source'],
      page: (sql, after) => repo.pageCalls(viewer, sql, a(after)),
      row: (r) => [
        r.id, r.cardId, r.clientId, r.userId, r.direction, r.via, r.phoneDigits, r.outcomeCode, r.outcomeKind, r.reasonCode, r.note, r.lpr,
        at(r.callbackAt), r.applied, r.factReason, at(r.occurredAt), r.durationSec, r.durationSource,
      ],
    }),
    t<repo.BookingRow>({
      name: 'bookings',
      header: [
        'id', 'kind', 'event_type_key', 'event_id', 'resource_id', 'client_id', 'card_id', 'deal_id', 'contact_id', 'booking_date', 'start_time',
        'duration_min', 'direction_key', 'is_reserve', 'status', 'cancel_reason', 'via', 'booked_by_user_id', 'responsible_user_id',
        'moved_from_id', 'moved_to_id', 'custom', 'created_at',
      ],
      page: (sql, after) => repo.pageBookings(viewer, sql, a(after)),
      row: (r) => [
        r.id, r.kind, r.eventTypeKey, r.eventId, r.resourceId, r.clientId, r.cardId, r.dealId, r.contactId, r.bookingDate, r.startTime,
        r.durationMin, r.directionKey, flag(r.isReserve), r.status, r.cancelReason, r.via, r.bookedByUserId, r.responsibleUserId,
        r.movedFromId, r.movedToId, custom('booking', r.custom), at(r.createdAt),
      ],
    }),
    t<repo.EventRow>({
      name: 'events',
      header: ['id', 'series_id', 'event_type_key', 'event_date', 'start_time', 'duration_min', 'location', 'format', 'capacity', 'status', 'created_at'],
      page: (sql, after) => repo.pageEvents(viewer, sql, a(after)),
      row: (r) => [r.id, r.seriesId, r.eventTypeKey, r.eventDate, r.startTime, r.durationMin, r.location, r.format, r.capacity, r.status, at(r.createdAt)],
    }),
    t<repo.DealRow>({
      name: 'deals',
      header: [
        'id', 'pipeline_key', 'stage_key', 'status', 'client_id', 'card_id', 'owner_user_id', 'service_type_key', 'service_variant_key', 'amount_kzt', 'won_at', 'lost_at',
        'lost_reason_code', 'lost_reason_text', 'needs_rebook', 'stage_changed_at', 'custom', 'created_by', 'created_at',
      ],
      page: (sql, after) => repo.pageDeals(viewer, sql, a(after)),
      row: (r) => [
        r.id, r.pipelineKey, r.stageKey, r.status, r.clientId, r.cardId, r.ownerUserId, r.serviceTypeKey, r.serviceVariantKey, r.amountKzt, at(r.wonAt), at(r.lostAt),
        r.lostReasonCode, r.lostReasonText, flag(r.needsRebook), at(r.stageChangedAt), custom('deal', r.custom), r.createdBy, at(r.createdAt),
      ],
    }),
    t<repo.HandoffRow>({
      name: 'handoffs',
      header: ['id', 'deal_id', 'client_id', 'status', 'team_id', 'assignee_user_id', 'due_at', 'accepted_at', 'accepted_by', 'declined_reason', 'created_at'],
      page: (sql, after) => repo.pageHandoffs(viewer, sql, a(after)),
      row: (r) => [r.id, r.dealId, r.clientId, r.status, r.teamId, r.assigneeUserId, at(r.dueAt), at(r.acceptedAt), r.acceptedBy, r.declinedReason, at(r.createdAt)],
    }),
    t<repo.TaskRow>({
      name: 'tasks',
      header: ['id', 'client_id', 'deal_id', 'kind', 'source', 'title', 'due_at', 'assignee_user_id', 'team_id', 'status', 'created_by', 'done_at', 'created_at'],
      page: (sql, after) => repo.pageTasks(viewer, sql, a(after)),
      row: (r) => [r.id, r.clientId, r.dealId, r.kind, r.source, r.title, at(r.dueAt), r.assigneeUserId, r.teamId, r.status, r.createdBy, at(r.doneAt), at(r.createdAt)],
    }),
    t<repo.TaskCommentRow>({
      name: 'task_comments',
      header: ['id', 'task_id', 'author_id', 'body', 'created_at'],
      page: (sql, after) => repo.pageTaskComments(viewer, sql, a(after)),
      row: (r) => [r.id, r.taskId, r.authorId, r.body, at(r.createdAt)],
    }),
    t<repo.NoteRow>({
      name: 'notes',
      header: ['id', 'client_id', 'deal_id', 'author_id', 'body', 'pinned', 'edited_at', 'created_at'],
      page: (sql, after) => repo.pageNotes(viewer, sql, a(after)),
      row: (r) => [r.id, r.clientId, r.dealId, r.authorId, r.body, flag(r.pinned), at(r.editedAt), at(r.createdAt)],
    }),
    t<repo.TimelineRow>({
      name: 'timeline',
      header: ['id', 'client_id', 'kind', 'actor_id', 'at', 'deal_id', 'ref_type', 'ref_id', 'data'],
      page: (sql, after) => repo.pageTimeline(viewer, sql, { ...a(after), kinds: ctx.kinds, visibleRefs: ctx.visibleRefs }),
      row: (r) => [r.id, r.clientId, r.kind, r.actorId, at(r.at), r.dealId, r.refType, r.refId, JSON.stringify(pickData(r.kind, r.data))],
    }),
    t<repo.MessageRow>({
      name: 'messages',
      header: ['id', 'chat_ref', 'client_id', 'direction', 'msg_type', 'body', 'has_attachment', 'status', 'author_user_id', 'is_edited', 'is_deleted', 'sent_at'],
      page: (sql, after) => repo.pageMessages(viewer, sql, a(after)),
      row: (r) => [r.id, r.chatRef, r.clientId, r.direction, r.msgType, r.body, flag(r.hasAttachment), r.status, r.authorUserId, flag(r.isEdited), flag(r.isDeleted), at(r.sentAt)],
    }),
  ];
}

/** Второй рубеж для ленты: событие поля, скрытого для роли, не выгружается (первый — фильтр в SQL). */
function timelineVisible(ctx: Ctx, r: { kind: string; data: unknown }): boolean {
  if (r.kind !== 'field.changed') return true;
  const d = pickData(r.kind, r.data) as { obj?: unknown; sys?: unknown; field?: unknown };
  if (typeof d.obj !== 'string' || typeof d.field !== 'string') return false;
  return fields.canSeeFieldChange(ctx.fv, ctx.defs, { obj: d.obj as fields.FieldObject, sys: d.sys === true, field: d.field });
}

async function* rowsOf(sql: Sql, table: Table<{ id: string }>, ctx: Ctx, counter: { n: number }): AsyncGenerator<CsvCellValue[]> {
  yield table.header;
  let after: string | null = null;
  for (;;) {
    const page = await table.page(sql, after);
    for (const r of page) {
      if (table.name === 'timeline' && !timelineVisible(ctx, r as unknown as { kind: string; data: unknown })) continue;
      counter.n++;
      yield table.row(r);
    }
    if (page.length < repo.PAGE_ROWS) return;
    after = (page[page.length - 1] as { id: string }).id;
  }
}

const json = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v, null, 2));

/** Запись архива: одна транзакция REPEATABLE READ READ ONLY — один снимок на все таблицы. */
async function produce(viewer: Viewer, db: Db, zip: ZipWriter, ctx: Ctx, expected: Record<FullExportTable, number>): Promise<void> {
  const deadline = setTimeout(() => zip.abort('timeout'), FULL_EXPORT_DEADLINE_MS);
  deadline.unref?.();
  try {
    const written = await db.tx(async (sql) => {
      await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      await sql`SET LOCAL statement_timeout = '600s'`;
      for (const f of ctx.configFiles) await zip.addFile(f.name, json(f.body));
      const counts: Partial<Record<FullExportTable, number>> = {};
      for (const table of tablesOf(viewer, ctx)) {
        // сообщения мессенджера — только если они есть (интеграция выключена — файла нет)
        if (table.name === 'messages' && expected.messages === 0) continue;
        const counter = { n: 0 };
        await zip.addFile(`${table.name}.csv`, toExcelCsvLines(rowsOf(sql, table, ctx, counter)));
        counts[table.name] = counter.n;
      }
      return counts;
    });
    await zip.addFile(
      'manifest.json',
      json({
        format: 'crm-full-export',
        version: 1,
        productVersion: pkg.version,
        generatedAt: stampFormatter(ctx.timeZone)(viewer.now),
        timeZone: ctx.timeZone,
        space: ctx.spaceKey,
        tables: written,
      }),
    );
    await zip.finish();
    // отметка завершения (D-294) — только после того, как архив дописан; оборванная или упавшая по пределу
    // времени выгрузка её не получает и в лимит завершённых не идёт
    await writeFullExportDone(db.sql, viewer, Object.values(written).reduce((s, n) => s + (n ?? 0), 0));
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    zip.abort(typeof code === 'string' ? code : 'failed');
    // в лог — только код, без значений строк (detail ошибок Postgres содержит ПДн)
    console.error('[export] полная выгрузка оборвана', typeof code === 'string' ? code : (e as { name?: unknown } | null)?.name ?? 'error');
  } finally {
    clearTimeout(deadline);
  }
}

/** Имя архива: местное время установки, только ASCII. */
function filenameOf(viewer: Viewer): string {
  const p = time.toLocalTime(viewer.now, viewer.timeZone);
  const two = (n: number) => String(n).padStart(2, '0');
  return `crm-full-${p.year}${two(p.month)}${two(p.dayOfMonth)}-${two(p.hour)}${two(p.minute)}.zip`;
}

function modifiedAtOf(viewer: Viewer): Date {
  const p = time.toLocalTime(viewer.now, viewer.timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.dayOfMonth, p.hour, p.minute, p.second));
}

export const streamFullExport: StreamFullExport = async (viewer, input) => {
  const spaceId = requireFullExport(viewer);
  // нет, просрочен или чужой — билет гасится и 404, как у несуществующего
  if (!ticketValid(input.ticket, viewer.userId, viewer.now)) {
    consumeTicket(input.ticket, viewer.userId, viewer.now);
    throw new NotFoundError();
  }
  // «занято» билет не гасит (D-294): повтор с ним же в пределах 60 с, без нового пароля. Проверка, захват и
  // погашение идут подряд без await — второй запрос с тем же билетом между ними не пройдёт
  if (!acquire(viewer.userId, viewer.now)) throw new ExportLimitError('busy');
  consumeTicket(input.ticket, viewer.userId, viewer.now);
  let handedOver = false;
  try {
    const ctx = await contextOf(viewer, spaceId);
    const db = await getDb();
    const expected = await db.tx(async (sql) => {
      // повторная проверка лимита под семафором: два билета подряд не дают четвёртую выгрузку
      if (!underLimits(await exportsToday(sql, viewer))) throw new ExportLimitError('export_limit');
      const counts = await repo.countFullExport(viewer, sql, { spaceId, kinds: ctx.kinds, visibleRefs: ctx.visibleRefs });
      const rows = Object.values(counts).reduce((s, n) => s + n, 0);
      await writeExportLogIn(sql, viewer, { kind: 'full', reportKey: null, format: 'zip', rows, filterKeys: [], periodDays: null });
      await notifyRoles(sql, {
        spaceId,
        roles: ctx.recipientRoles,
        extraUserIds: await repo.selectActiveAdmins(sql),
        kind: NOTIFY_KIND_FULL_EXPORT,
        eventId: `export_full:${newId()}`,
        newId,
        now: viewer.now,
      });
      return counts;
    });
    const zip = createZipWriter({ modifiedAt: modifiedAtOf(viewer) });
    handedOver = true;
    void produce(viewer, db, zip, ctx, expected).finally(release);
    return { filename: filenameOf(viewer), stream: zip.stream };
  } finally {
    if (!handedOver) release();
  }
};
