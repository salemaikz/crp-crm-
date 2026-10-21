// Сводка, блокеры, отметка в отчёте и строки профиля «Записи» (D-324, docs/import-bookings-design.md §7, §12).
// В `imports.report` попадают только коды, id, числа и хэши ярлыков; имена и номера уходят лишь РОП в ответе.
import { imports } from '@crm/core';
import { ForbiddenError, NotFoundError, scopeOf } from '@/server/access';
import type { Sql } from '@/server/platform/db/core';
import * as bookingRepo from './bookingRepo';
import { authorHintsOf, authorLabelRef, type BookingComputation } from './bookingLoad';
import { ImportError } from './errors';
import { configUnchanged } from './preview';
import { buildId, importBookingsEnabled } from './platformGlue';
import * as repo from './repo';
import type { ImportContext } from './settings';
import type {
  ApplyBlocker,
  BookingPreviewSummary,
  BookingRowView,
  BookingsPreviewStamp,
  ImportActor,
  ImportProfileSetting,
  RowFilter,
} from './types';
import type { Viewer } from '@/server/access';

/**
 * Профиль «Записи» доступен РОП: `import.run` (маршрут), `booking.create` и `card.assign` с охватом пространства.
 * Администратор без роли охватов не имеет — до строк файла дело не доходит (D-116).
 */
export function bookingViewerOf(actor: ImportActor): Viewer {
  const v = actor.viewer;
  if (!importBookingsEnabled() || !v || v.spaceId === null || v.spaceId !== actor.spaceId) throw new NotFoundError();
  if (scopeOf(v, 'booking.create') !== 'space' || scopeOf(v, 'card.assign') !== 'space') throw new ForbiddenError();
  return v;
}

/** Профиль загрузки должен быть профилем «Записи», иначе загрузка — не для этого входа (`bad_profile`). */
export function bookingProfileOf(ctx: ImportContext, profileKey: string): ImportProfileSetting {
  const p = ctx.settings.profiles.find((x) => x.key === profileKey);
  if (!p || p.kind !== 'bookings' || !p.bookings) throw new ImportError('bad_profile');
  return p;
}

export function bookingBlockersOf(imp: repo.ImportRow, ctx: ImportContext, rowsPresent: boolean, comp: BookingComputation | null): ApplyBlocker[] {
  const b: ApplyBlocker[] = [];
  if (imp.status === 'applied') b.push('already_applied');
  if (imp.status === 'failed') b.push('failed');
  if (!rowsPresent) b.push('rows_expired');
  if (!configUnchanged(imp.report, ctx)) b.push('config_changed');
  if (ctx.agreedOutcomeKey === null) b.push('no_agreed_outcome');
  if (comp) {
    if (comp.preview.unmappedAuthors.length > 0) b.push('unmapped_authors');
    const c = comp.preview.counts.byAction;
    if (c.create + c.changed_in_file === 0) b.push('nothing_to_apply');
  }
  return b;
}

/** Задачи «Уточнить договорённость», которые закроют переходы: карточка в `callback` с открытой задачей (D-050). */
async function clarifyToClose(sql: Sql, ctx: ImportContext, comp: BookingComputation): Promise<number> {
  const byClient = new Map(comp.inputs.candidates.map((c) => [c.clientId, c]));
  const clients = comp.preview.rows.flatMap((r) => (r.action === 'create' && r.transition === 'to_agreed' && r.clientId && byClient.get(r.clientId)?.state === 'callback' ? [r.clientId] : []));
  return bookingRepo.countOpenClarifyOf(sql, ctx.spaceId, [...new Set(clients)]);
}

export async function bookingSummaryOf(sql: Sql, imp: repo.ImportRow, ctx: ImportContext, comp: BookingComputation, blockers: readonly ApplyBlocker[]): Promise<BookingPreviewSummary> {
  const { hints } = await authorHintsOf(sql, ctx, imp.id);
  const close = await clarifyToClose(sql, ctx, comp);
  const open = await bookingRepo.countOpenClarify(sql, ctx.spaceId);
  return {
    kind: 'bookings',
    importId: imp.id,
    fingerprint: comp.fingerprint,
    counts: comp.preview.counts,
    byEvent: comp.preview.byEvent.map((e) => ({ ...e, typeLabel: ctx.eventTypeLabels[e.typeKey] ?? e.typeKey })),
    willAgree: comp.preview.counts.toAgreed,
    clarifyToClose: close,
    clarifyRemaining: Math.max(0, open - close),
    hints,
    unmappedAuthors: comp.preview.unmappedAuthors,
    blockers,
  };
}

/** Отметка предпросмотра в отчёте: отпечаток, ревизии, ссылки на авторов по хэшу ярлыка, счётчики. */
export function bookingStampOf(comp: BookingComputation, ctx: ImportContext, actorId: string, now: number): BookingsPreviewStamp {
  const ref: Record<string, string | null> = {};
  const labels = new Set(comp.rows.flatMap((r) => (r.authorLabel ? [r.authorLabel] : [])));
  for (const l of labels) {
    const hit = Object.entries(comp.authorMap).find(([k]) => imports.normalizeLabel(k) === imports.normalizeLabel(l));
    if (hit) ref[authorLabelRef(l)] = hit[1];
  }
  return { kind: 'bookings', fingerprint: comp.fingerprint, at: now, by: actorId, buildId: buildId(), configRev: ctx.rev, authorMapRef: ref, counts: comp.preview.counts };
}

// ---------- Строки ----------

const GROUP_PREFIX = 'group_';

export function bookingRowMatches(filter: RowFilter, pr: imports.BookingPreviewRow): boolean {
  if (filter === 'all') return true;
  if (filter.startsWith(GROUP_PREFIX)) return pr.groups.includes(filter.slice(GROUP_PREFIX.length) as imports.BookingGroup);
  return pr.action === filter;
}

export function bookingRowView(pr: imports.BookingPreviewRow, row: imports.ParsedBookingRow): BookingRowView {
  return {
    rowNo: row.rowNo,
    name: row.name,
    phones: row.phonesRaw,
    eventDate: row.eventDate,
    eventTime: row.eventTime,
    eventTypeKey: row.eventTypeKey,
    eventTypeRaw: row.eventTypeRaw,
    authorLabel: row.authorLabel,
    action: pr.action,
    groups: pr.groups,
    flags: pr.flags,
    clientId: pr.clientId,
    eventId: pr.eventId,
    bookingId: pr.bookingId,
    issues: pr.issues,
  };
}
