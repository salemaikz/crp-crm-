// Загрузка файла профиля «Записи» (D-324, docs/import-bookings-design.md §12): сигнатура, пределы (maxRows профиля),
// разбор по профилю, запись imports + import_rows (status preview). Файл не хранится. ИИН «личных» форм в строки
// не попадает: ядро делает из него `iin:<HMAC>` при разборе (D-052).
import { imports, time } from '@crm/core';
import { BadRequestError } from '@/server/access';
import { getDb, newId } from '@/server/platform/db';
import { limitsFor, readSpreadsheet } from '@/server/platform/files';
import { bookingProfileOf, bookingViewerOf } from './bookingSummary';
import { ImportError } from './errors';
import { sha256 } from './load';
import { buildId, importBookingsEnabled, iinHmac } from './platformGlue';
import * as repo from './repo';
import type { ImportContext } from './settings';
import type { ImportActor, ImportReportV1, UploadInput, UploadResult } from './types';
import { cleanFileName } from './upload';

const worstIssue = (r: imports.ParsedBookingRow): string =>
  r.issues.find((i) => i.severity === 'error')?.code ?? r.issues.find((i) => i.severity === 'review')?.code ?? '';

export async function uploadBookings(ctx: ImportContext, actor: ImportActor, input: UploadInput, now: number): Promise<UploadResult> {
  // Флаг выключен — профиля «Записи» как будто нет (400), нет охватов РОП — отказ (403)
  if (!importBookingsEnabled()) throw new ImportError('bad_profile');
  bookingViewerOf(actor);
  const profile = bookingProfileOf(ctx, input.profileKey);
  const setting = profile.bookings;
  if (!setting) throw new ImportError('bad_profile');
  if (!time.isValidDay(input.snapshotDay) || input.snapshotDay > time.localDayOf(now, ctx.timeZone)) throw new BadRequestError('snapshot_day');

  // Предел строк профиля сужает общий предел установки (запись идёт через createBooking построчно)
  const limits = limitsFor({ maxFileMb: ctx.settings.maxFileMb, maxRows: Math.min(ctx.settings.maxRows, setting.maxRows) });
  const res = await readSpreadsheet(input.body, { limits, ...(input.sheet !== undefined ? { sheet: input.sheet } : {}) });
  const cp = imports.compileBookingProfile({
    key: profile.key,
    columns: profile.columns,
    eventTypeMap: setting.eventTypeMap,
    ...(setting.defaultEventTypeKey !== undefined ? { defaultEventTypeKey: setting.defaultEventTypeKey } : {}),
    ...(profile.headerScanRows !== undefined ? { headerScanRows: profile.headerScanRows } : {}),
  });
  const parsed = imports.parseBookingSheet(res.grid, cp, { normalizers: ctx.normalizers, hash: sha256, hmac: iinHmac });
  if (!parsed.ok) {
    const wanted: string[] = [imports.BOOKING_FIELDS.eventDate, imports.BOOKING_FIELDS.phones, imports.BOOKING_FIELDS.orgId];
    const labels = Object.entries(profile.columns).filter(([, f]) => wanted.includes(f)).map(([h]) => h);
    throw new ImportError('header_not_found', { missing: labels.length > 0 ? labels : parsed.missing });
  }

  const rows = parsed.rows;
  const issues: Record<string, number> = {};
  for (const r of rows) for (const code of new Set(r.issues.map((i) => i.code))) issues[code] = (issues[code] ?? 0) + 1;
  const importId = newId();
  const report: ImportReportV1 = {
    v: 1,
    input: { kind: res.kind, encoding: res.encoding, bytes: input.body.length, sheetIndex: res.sheetIndex, snapshotDay: input.snapshotDay, parseConfigRev: ctx.rev, buildId: buildId() },
    parse: {
      headerRow: parsed.headerRow,
      rows: rows.length,
      skippedBlank: parsed.skippedBlank,
      unmappedHeaders: parsed.unmappedHeaders.length,
      truncatedCells: res.stats.truncatedCells,
      droppedColumns: res.stats.droppedColumns,
      formulaWithoutValue: res.stats.formulaWithoutValue,
      errorCells: res.stats.errorCells,
      issues,
    },
  };

  const db = await getDb();
  const same = await db.tx(async (sql) => {
    await repo.insertImport(sql, { id: importId, spaceId: ctx.spaceId, fileName: cleanFileName(input.fileName), fileSha256: res.sha256, profileKey: profile.key, report, createdBy: actor.userId, now });
    await repo.insertImportRows(
      sql,
      importId,
      rows.map((r) => ({ id: newId(), rowNo: r.rowNo, importKey: imports.importKeyOf(r.rowKey, r.stateKey), parsed: r, issue: worstIssue(r) })),
      now,
    );
    await repo.insertAudit(sql, { id: newId(), actorId: actor.userId, spaceId: ctx.spaceId, action: 'import.upload', entityId: importId, meta: { importId, rows: rows.length, kind: res.kind }, now });
    return repo.findAppliedSameFile(sql, ctx.spaceId, res.sha256, profile.key);
  });
  return {
    importId,
    kind: res.kind,
    sheets: res.sheets,
    sheetIndex: res.sheetIndex,
    headerRow: parsed.headerRow,
    rows: rows.length,
    skippedBlank: parsed.skippedBlank,
    unmappedHeaders: parsed.unmappedHeaders,
    sameFileApplied: same ? { importId: same.id, appliedAt: same.appliedAt } : null,
  };
}
