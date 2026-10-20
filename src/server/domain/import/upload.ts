// Загрузка файла (дизайн C4d §3, §5): сигнатура, пределы, разбор по профилю, redactPersonalId, запись
// imports + import_rows (status preview). Файл не хранится: в imports — sha256, имя и размер.
import { imports, time } from '@crm/core';
import { BadRequestError } from '@/server/access/errors';
import { getDb, newId } from '@/server/platform/db';
import { limitsFor, readSpreadsheet } from '@/server/platform/files';
import { ImportError } from './errors';
import { sha256 } from './load';
import { buildId, iinHmac } from './platformGlue';
import * as repo from './repo';
import type { ImportContext } from './settings';
import type { ImportActor, ImportReportV1, UploadInput, UploadResult } from './types';

const FILE_NAME_MAX = 120;

/** Имя файла: без управляющих символов, не длиннее 120. В лог и аудит не пишется. */
export const cleanFileName = (s: string): string => s.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, FILE_NAME_MAX);

/** Худший код замечания строки: error › review, иначе пусто. */
export function worstIssue(r: imports.ParsedRow): string {
  return r.issues.find((i) => i.severity === 'error')?.code ?? r.issues.find((i) => i.severity === 'review')?.code ?? '';
}

export async function uploadImport(ctx: ImportContext, actor: ImportActor, input: UploadInput, now: number): Promise<UploadResult> {
  const profile = ctx.settings.profiles.find((p) => p.key === input.profileKey && p.kind === 'clients');
  if (!profile) throw new ImportError('bad_profile');
  if (!time.isValidDay(input.snapshotDay) || input.snapshotDay > time.localDayOf(now, ctx.timeZone)) throw new BadRequestError('snapshot_day');

  const res = await readSpreadsheet(input.body, { limits: limitsFor(ctx.settings), ...(input.sheet !== undefined ? { sheet: input.sheet } : {}) });
  const cp = imports.compileProfile(profile);
  const parsed = imports.parseSheet(res.grid, cp, { normalizers: ctx.normalizers, hash: sha256 });
  if (!parsed.ok) {
    // Ядро называет поля, которых нет в профиле; если профиль их знает, но в файле заголовков нет — подписи колонок профиля
    const labels = Object.entries(profile.columns).filter(([, f]) => f === imports.IMPORT_FIELDS.name || f === imports.IMPORT_FIELDS.phones).map(([h]) => h);
    throw new ImportError('header_not_found', { missing: parsed.missing.length > 0 ? parsed.missing : labels });
  }

  // ИИН ИП и «личных» форм в import_rows не попадает: остаётся только HMAC (D-052)
  const rows = parsed.rows.map((r) => imports.redactPersonalId(r, iinHmac));
  const issues: Record<string, number> = {};
  for (const r of rows) for (const code of new Set(r.issues.map((i) => i.code))) issues[code] = (issues[code] ?? 0) + 1;
  const importId = newId();
  const report: ImportReportV1 = {
    v: 1,
    input: {
      kind: res.kind,
      encoding: res.encoding,
      bytes: input.body.length,
      sheetIndex: res.sheetIndex,
      snapshotDay: input.snapshotDay,
      parseConfigRev: ctx.rev,
      buildId: buildId(),
    },
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
