// Предпросмотр, строки и выгрузка профиля «Записи» (D-324, docs/import-bookings-design.md §7, §12). Применение —
// bookingApply.ts. Охват — пространство РОП; `booking.create` и `card.assign` с охватом space проверяет
// bookingViewerOf до чтения строк файла. Бизнес-таблицы предпросмотр не меняет.
import { getDb, newId } from '@/server/platform/db';
import { toExcelCsv } from '@/server/platform/files';
import { assertAuthors } from './bookingApply';
import { computeBookingPreview, restoreAuthorMap } from './bookingLoad';
import { bookingBlockersOf, bookingProfileOf, bookingRowMatches, bookingRowView, bookingStampOf, bookingSummaryOf, bookingViewerOf } from './bookingSummary';
import { ImportError } from './errors';
import { loadImportOrThrow } from './preview';
import * as repo from './repo';
import { loadImportContext } from './settings';
import type { BookingPreviewSummary, BookingRowView, ImportActor, PreviewRequest, RowFilter, RowQuery } from './types';

/** Коды колонок выгрузки «Записей»; маршрут подставляет переведённые подписи. */
export const BOOKING_EXPORT_HEADERS = ['row', 'name', 'phones', 'date', 'time', 'type', 'operator', 'action', 'groups', 'flags', 'issues'] as const;

export function bookingCsvOf(rows: readonly BookingRowView[], headers: readonly string[]): string {
  return toExcelCsv([
    [...headers],
    ...rows.map((r) => [r.rowNo, r.name, r.phones.join(', '), r.eventDate ?? '', r.eventTime ?? '', r.eventTypeKey ?? r.eventTypeRaw, r.authorLabel ?? '', r.action, r.groups.join(', '), r.flags.join(', '), r.issues.join(', ')]),
  ]);
}

export const bookingImportService = {
  async preview(actor: ImportActor, importId: string, req: PreviewRequest, now: number): Promise<BookingPreviewSummary> {
    const viewer = bookingViewerOf(actor);
    const ctx = await loadImportContext(actor.spaceId);
    const db = await getDb();
    return db.tx(async (sql) => {
      const imp = loadImportOrThrow(await repo.selectImport(sql, actor.spaceId, importId));
      bookingProfileOf(ctx, imp.profileKey);
      const stored = await repo.selectRows(sql, importId);
      if (stored.length === 0) throw new ImportError('rows_expired');
      await assertAuthors(sql, ctx, req.authorMap);
      const comp = await computeBookingPreview(sql, ctx, viewer, imp, stored, req.authorMap, now);
      const blockers = bookingBlockersOf(imp, ctx, true, comp);
      // Отметка предпросмотра в отчёте (без имён и номеров); применённый или упавший импорт отчёт не меняет
      if (imp.status === 'preview') await repo.saveReport(sql, importId, { ...imp.report, preview: bookingStampOf(comp, ctx, actor.userId, now) });
      return bookingSummaryOf(sql, imp, ctx, comp, blockers);
    });
  },

  /** Строки по фильтру с картой авторов из последнего предпросмотра. null — строки удалены по сроку. */
  async rowsOf(actor: ImportActor, importId: string, filter: RowFilter, now: number): Promise<BookingRowView[]> {
    const viewer = bookingViewerOf(actor);
    const ctx = await loadImportContext(actor.spaceId);
    const db = await getDb();
    const imp = loadImportOrThrow(await repo.selectImport(db.sql, actor.spaceId, importId));
    bookingProfileOf(ctx, imp.profileKey);
    const stored = await repo.selectRows(db.sql, importId);
    if (stored.length === 0) throw new ImportError('rows_expired');
    const labels = (await repo.selectAuthorLabels(db.sql, importId)).map((l) => l.label);
    const comp = await computeBookingPreview(db.sql, ctx, viewer, imp, stored, restoreAuthorMap(imp.report, labels), now);
    const out: BookingRowView[] = [];
    for (const pr of comp.preview.rows) {
      const row = comp.rowByNo.get(pr.rowNo);
      if (row && bookingRowMatches(filter, pr)) out.push(bookingRowView(pr, row));
    }
    return out;
  },

  async listRows(actor: ImportActor, importId: string, q: RowQuery, now: number): Promise<{ rows: BookingRowView[]; total: number }> {
    const all = await bookingImportService.rowsOf(actor, importId, q.filter, now);
    const limit = Math.min(Math.max(q.limit, 1), 200);
    return { rows: all.slice(q.offset, q.offset + limit), total: all.length };
  },

  async exportRowsCsv(actor: ImportActor, importId: string, filter: RowFilter, now: number, headers: readonly string[] = BOOKING_EXPORT_HEADERS): Promise<{ csv: string; rows: number }> {
    const rows = await bookingImportService.rowsOf(actor, importId, filter, now);
    const db = await getDb();
    await repo.insertAudit(db.sql, { id: newId(), actorId: actor.userId, spaceId: actor.spaceId, action: 'import.export', entityId: importId, meta: { importId, filter, rows: rows.length }, now });
    return { csv: bookingCsvOf(rows, headers), rows: rows.length };
  },
};
