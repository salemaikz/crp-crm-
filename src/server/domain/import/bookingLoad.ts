// Входы и сам предпросмотр профиля «Записи» (D-324, docs/import-bookings-design.md §5–§7): строки из import_rows +
// состояние БД (клиенты с карточкой в пространстве РОП, мероприятия, записи, прошлые загрузки, участники раздачи)
// → imports.buildBookingPreview → отпечаток. Бизнес-таблицы не меняются; вызывается при предпросмотре и внутри
// транзакции применения, где вход читается заново — уже под блокировками.
import { dedup, imports, time } from '@crm/core';
import type { Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db/core';
import * as bookingRepo from './bookingRepo';
import { sha256 } from './load';
import { buildId, iinHmac } from './platformGlue';
import * as repo from './repo';
import type { ImportContext } from './settings';
import type { AuthorMapInput, BookingAuthorHint, BookingStaffItem, ImportProfileSetting } from './types';

const HIDDEN = dedup.HIDDEN_ORG_ID_PREFIX;

/** Ввод предпросмотра, прочитанный из БД (до расчёта). */
export interface BookingInputs {
  candidates: imports.BookingCandidate[];
  events: imports.BookingEventInfo[];
  clientBookings: imports.ClientBookingInfo[];
  prior: Map<string, imports.PriorBooking>;
  participants: Set<string>;
  /** Спорные пары кандидатов и карточки напарников (PROCESS 7.6, D-330). */
  pairs: imports.BookingPairInfo[];
  partnerCards: imports.BookingPartnerCard[];
}

export interface BookingComputation {
  profile: ImportProfileSetting;
  rows: imports.ParsedBookingRow[];
  rowByNo: Map<number, imports.ParsedBookingRow>;
  preview: imports.BookingPreview;
  fingerprint: string;
  today: string;
  /** Нормализованная карта: нерешённые и пустые ключи убраны; null — «автор неизвестен». */
  authorMap: Record<string, string | null>;
  inputs: BookingInputs;
}

export const bookingKeyOf = (spaceId: string) => (row: imports.ParsedBookingRow): string => imports.bookingImportKey(spaceId, row.rowKey, sha256);

/** Карта авторов от клиента → нормализованная: пустые ярлыки отброшены, значение — id или null. */
export function cleanAuthorMap(m: AuthorMapInput | undefined): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(m ?? {})) {
    if (k.trim() === '') continue;
    if (v === null) out[k] = null;
    else if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

/** Хэш ярлыка для `report.preview.authorMapRef`: имена сотрудников-ярлыков в отчёт не пишутся. */
export const authorLabelRef = (label: string): string => sha256(imports.normalizeLabel(label)).slice(0, 16);

/** Ключи кандидатов: открытые БИН, HMAC ИИН, рабочие номера. */
function candidateKeys(rows: readonly imports.ParsedBookingRow[]): { bins: string[]; iinHmacs: string[]; phones: string[] } {
  const bins = new Set<string>();
  const iins = new Set<string>();
  const phones = new Set<string>();
  for (const r of rows) {
    if (r.orgId) {
      if (r.orgId.startsWith(HIDDEN)) iins.add(r.orgId.slice(HIDDEN.length));
      else bins.add(r.orgId);
    }
    for (const p of r.workingPhones) phones.add(p);
  }
  return { bins: [...bins], iinHmacs: [...iins], phones: [...phones] };
}

/** Чтение входов предпросмотра (без блокировок): все запросы — с `space_id` и охватом РОП. */
export async function loadBookingInputs(sql: Sql, ctx: ImportContext, viewer: Viewer, rows: readonly imports.ParsedBookingRow[]): Promise<BookingInputs> {
  const keys = candidateKeys(rows);
  const candRows = await bookingRepo.selectBookingCandidates(viewer, sql, { spaceId: ctx.spaceId, ...keys });
  const candidates: imports.BookingCandidate[] = candRows.map((c) => ({
    clientId: c.clientId,
    cardId: c.cardId,
    nameNorm: c.nameNorm,
    orgId: c.orgId,
    iinKey: c.iinHmac ? `${HIDDEN}${c.iinHmac}` : null,
    phones: c.phones,
    state: c.state,
    ownerUserId: c.ownerUserId,
    holdReason: c.holdReason,
    touchedInCrm: c.touchedInCrm,
  }));
  const dates = [...new Set(rows.flatMap((r) => (r.eventDate ? [r.eventDate] : [])))];
  const eventRows = await bookingRepo.selectBookingEvents(viewer, sql, { spaceId: ctx.spaceId, groupTypes: [...ctx.groupTypeKeys], dates });
  const events: imports.BookingEventInfo[] = eventRows.map((e) => ({
    id: e.id,
    typeKey: e.eventTypeKey,
    date: e.eventDate,
    time: e.startTime,
    status: e.status,
    capacity: e.capacity,
    taken: e.taken,
    startsAt: e.startsAt,
    durationMin: e.durationMin,
  }));
  const bookingRows = await bookingRepo.selectClientBookings(viewer, sql, { spaceId: ctx.spaceId, clientIds: candidates.map((c) => c.clientId) });
  const clientBookings: imports.ClientBookingInfo[] = bookingRows.map((b) => ({ clientId: b.clientId, eventId: b.eventId, typeKey: b.eventTypeKey, status: b.status, startsAt: b.startsAt }));
  const keyOf = bookingKeyOf(ctx.spaceId);
  const priorRows = await bookingRepo.selectPriorBookings(viewer, sql, { spaceId: ctx.spaceId, keys: rows.map(keyOf) });
  const prior = new Map(priorRows.map((p) => [p.importKey, { bookingId: p.bookingId, stateKey: p.stateKey }]));
  const participants = new Set((await repo.selectParticipants(sql, ctx.spaceId, ctx.participantRoles)).map((p) => p.userId));
  // Пары не делятся и импортом (PROCESS 7.6): пары кандидатов и карточки напарников — как в раздаче (D-174)
  const pairs = await bookingRepo.selectPairsOfClients(sql, candidates.map((c) => c.clientId));
  const partnerIds = new Set(pairs.flatMap((p) => [p.aClientId, p.bClientId]));
  const partnerCards = await bookingRepo.selectPartnerCards(sql, { spaceId: ctx.spaceId, clientIds: [...partnerIds] });
  return { candidates, events, clientBookings, prior, participants, pairs, partnerCards };
}

export async function computeBookingPreview(
  sql: Sql,
  ctx: ImportContext,
  viewer: Viewer,
  imp: { id: string; fileSha256: string; profileKey: string; report: { input: { snapshotDay: string } } },
  stored: readonly repo.StoredRow[],
  authorMapIn: AuthorMapInput | undefined,
  now: number,
  preloaded?: BookingInputs,
): Promise<BookingComputation> {
  const profile = ctx.settings.profiles.find((p) => p.key === imp.profileKey);
  if (!profile) throw new Error('profile_gone');
  const rows = stored.map((r) => r.parsed as imports.ParsedBookingRow);
  const authorMap = cleanAuthorMap(authorMapIn);
  const inputs = preloaded ?? (await loadBookingInputs(sql, ctx, viewer, rows));
  const today = time.localDayOf(now, ctx.timeZone);
  const preview = imports.buildBookingPreview({
    rows,
    groupTypeKeys: ctx.groupTypeKeys,
    candidates: inputs.candidates,
    events: inputs.events,
    clientBookings: inputs.clientBookings,
    prior: inputs.prior,
    importKeyOf: bookingKeyOf(ctx.spaceId),
    authorMap,
    participants: inputs.participants,
    pairs: inputs.pairs,
    partnerCards: inputs.partnerCards,
    today,
    now,
    hidden: (bin) => `${HIDDEN}${iinHmac(bin)}`,
  });
  const fingerprint = imports.bookingPreviewFingerprint(
    {
      buildId: buildId(),
      configRev: ctx.rev,
      importId: imp.id,
      fileSha256: imp.fileSha256,
      profileKey: imp.profileKey,
      snapshotDay: imp.report.input.snapshotDay,
      today,
      authorMap,
      rows: preview.rows,
    },
    sha256,
  );
  return { profile, rows, rowByNo: new Map(rows.map((r) => [r.rowNo, r])), preview, fingerprint, today, authorMap, inputs };
}

/** Подсказки авторов для экрана РОП: ярлыки из файла с числом строк и предложенным сотрудником (по номеру или ФИО). */
export async function authorHintsOf(sql: Sql, ctx: ImportContext, importId: string): Promise<{ hints: BookingAuthorHint[]; staff: BookingStaffItem[] }> {
  const labels = await repo.selectAuthorLabels(sql, importId);
  const staffRows = await bookingRepo.selectSpaceStaff(sql, ctx.spaceId);
  const staff: imports.AuthorStaff[] = staffRows.map((s) => ({ userId: s.userId, name: s.name, phoneDigits: s.phoneDigits }));
  const names = new Map(staffRows.map((s) => [s.userId, s.name]));
  // Написания, отличающиеся регистром и пробелами, — один ярлык (карта авторов сравнивает их нормализованными)
  const merged = new Map<string, { label: string; rows: number }>();
  for (const l of labels) {
    const k = imports.normalizeLabel(l.label);
    const seen = merged.get(k);
    if (seen) seen.rows += l.rows;
    else merged.set(k, { ...l });
  }
  const hints = [...merged.values()].map((l): BookingAuthorHint => {
    const sg = imports.suggestAuthor(l.label, staff, ctx.normalizers);
    return { label: l.label, rows: l.rows, by: sg.by, suggestedUserId: sg.userId, suggestedName: sg.userId ? (names.get(sg.userId) ?? '') : '' };
  });
  return { hints, staff: staffRows.map((s) => ({ userId: s.userId, name: s.name, disabled: s.status !== 'active' })) };
}

/** Карта авторов из последнего предпросмотра: ярлык → id по хэшу ярлыка (имена в отчёте не хранятся). */
export function restoreAuthorMap(report: { preview?: { kind?: string; authorMapRef?: Record<string, string | null> } | undefined }, labels: readonly string[]): AuthorMapInput {
  const ref = report.preview?.kind === 'bookings' ? (report.preview.authorMapRef ?? {}) : {};
  const out: Record<string, string | null> = {};
  for (const l of labels) {
    const v = ref[authorLabelRef(l)];
    if (v !== undefined) out[l] = v;
  }
  return out;
}
