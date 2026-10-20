// Сервис импорта (дизайн C4d §13): реализует ImportService. Охват — пространство действующего: чужой
// импорт = несуществующий (404, D-017). FEATURE_IMPORT выключен — 404 на всём (D-116). Права проверяют
// обёртки маршрутов (import.run); здесь — пространство и состояние.
import { NotFoundError } from '@/server/access/errors';
import { getDb, newId } from '@/server/platform/db';
import { limitsFor } from '@/server/platform/files';
import { applyImport } from './apply';
import { ImportError } from './errors';
import { computePreview } from './load';
import { importEnabled } from './platformGlue';
import { assertOwners, blockersOf, countHeldWorking, loadImportOrThrow, restoreOwnerMap, stampOf, summaryOf } from './preview';
import * as repo from './repo';
import { csvOf, filteredRows } from './rows';
import { loadImportContext } from './settings';
import type {
  ApplyRequest,
  ApplyResult,
  ImportActor,
  ImportDetails,
  ImportListItem,
  ImportService,
  PreviewRequest,
  PreviewSummary,
  RowFilter,
  RowQuery,
  UploadInput,
  UploadResult,
} from './types';
import { uploadImport } from './upload';
import { ownerLabelsOf } from './load';

export const MAX_LIST = 50;

/** Выключенный модуль и пользователь без пространства неотличимы от «нет такого». */
function assertAvailable(actor: ImportActor): void {
  if (!importEnabled() || !actor.spaceId) throw new NotFoundError();
}

function itemOf(i: repo.ImportRow, hasRows: boolean): ImportListItem {
  return {
    id: i.id,
    fileName: i.fileName,
    profileKey: i.profileKey,
    status: i.status,
    rows: i.report.parse.rows,
    createdAt: i.createdAt,
    createdBy: i.createdBy,
    appliedAt: i.appliedAt,
    rowsExpired: !hasRows && i.report.parse.rows > 0,
  };
}

export const importService: ImportService = {
  async listImports(actor, limit) {
    assertAvailable(actor);
    const db = await getDb();
    const rows = await repo.selectImports(db.sql, actor.spaceId, Math.min(Math.max(limit, 1), MAX_LIST));
    return rows.map((r) => itemOf(r, r.hasRows));
  },

  async getImport(actor, importId): Promise<ImportDetails | null> {
    assertAvailable(actor);
    const db = await getDb();
    const imp = await repo.selectImport(db.sql, actor.spaceId, importId);
    if (!imp) return null;
    const ctx = await loadImportContext(actor.spaceId);
    const profile = ctx.settings.profiles.find((p) => p.key === imp.profileKey);
    const labels = !profile ? [] : profile.ownerBy.kind === 'row_ranges' ? ownerLabelsOf(profile, []) : await repo.selectOperatorLabels(db.sql, imp.id);
    const present = await repo.hasRows(db.sql, imp.id);
    const candidates = await repo.selectParticipants(db.sql, actor.spaceId, ctx.participantRoles);
    return { ...itemOf(imp, present), report: imp.report, ownerLabels: labels, savedOwnerMap: restoreOwnerMap(imp.report, labels), candidates };
  },

  async upload(actor, input: UploadInput, now): Promise<UploadResult> {
    assertAvailable(actor);
    const ctx = await loadImportContext(actor.spaceId);
    return uploadImport(ctx, actor, input, now);
  },

  async preview(actor, importId, req: PreviewRequest, now): Promise<PreviewSummary> {
    assertAvailable(actor);
    const ctx = await loadImportContext(actor.spaceId);
    const db = await getDb();
    return db.tx(async (sql) => {
      const imp = loadImportOrThrow(await repo.selectImport(sql, actor.spaceId, importId));
      const stored = await repo.selectRows(sql, importId);
      if (stored.length === 0) throw new ImportError('rows_expired');
      const participants = await assertOwners(sql, ctx, req.ownerMap);
      const comp = await computePreview(sql, ctx, imp, stored, req.ownerMap);
      const held = countHeldWorking(ctx, comp, imp, now);
      const blockers = blockersOf(imp, ctx, true, comp.preview.unmappedSlots.length);
      // Отметка предпросмотра в отчёте (без имён и номеров); применённый или упавший импорт отчёт не меняет
      if (imp.status === 'preview') await repo.saveReport(sql, importId, { ...imp.report, preview: stampOf(comp, ctx, actor.userId, held, now) });
      return summaryOf(imp, ctx, comp, participants, held, blockers);
    });
  },

  async listRows(actor, importId, q: RowQuery) {
    assertAvailable(actor);
    const ctx = await loadImportContext(actor.spaceId);
    const db = await getDb();
    const imp = loadImportOrThrow(await repo.selectImport(db.sql, actor.spaceId, importId));
    const all = await filteredRows(db.sql, ctx, imp, q.filter);
    if (all === null) throw new ImportError('rows_expired');
    const limit = Math.min(Math.max(q.limit, 1), 200);
    return { rows: all.slice(q.offset, q.offset + limit), total: all.length };
  },

  async exportRowsCsv(actor, importId, filter: RowFilter, now, headers: readonly string[] = DEFAULT_HEADERS) {
    assertAvailable(actor);
    const ctx = await loadImportContext(actor.spaceId);
    const db = await getDb();
    const imp = loadImportOrThrow(await repo.selectImport(db.sql, actor.spaceId, importId));
    const rows = await filteredRows(db.sql, ctx, imp, filter);
    if (rows === null) throw new ImportError('rows_expired');
    await repo.insertAudit(db.sql, { id: newId(), actorId: actor.userId, spaceId: actor.spaceId, action: 'import.export', entityId: importId, meta: { importId, filter, rows: rows.length }, now });
    return { csv: csvOf(rows, headers), rows: rows.length };
  },

  async apply(actor, importId, req: ApplyRequest, now): Promise<ApplyResult> {
    assertAvailable(actor);
    const ctx = await loadImportContext(actor.spaceId);
    return applyImport(ctx, actor, importId, req, now);
  },
};

/** Коды колонок выгрузки; маршрут подставляет переведённые подписи. */
export const DEFAULT_HEADERS = ['row', 'name', 'phones', 'operator', 'outcome', 'answer', 'action', 'hold', 'issues', 'flags'] as const;

/** Профили загрузки для формы: ключ и подпись (только таблицы клиентов; «Записи» — C4b). */
export async function listProfiles(actor: ImportActor): Promise<{ key: string; label: string }[]> {
  assertAvailable(actor);
  const ctx = await loadImportContext(actor.spaceId);
  return ctx.settings.profiles.filter((p) => p.kind === 'clients').map((p) => ({ key: p.key, label: p.label }));
}

/** Предел тела загрузки в байтах: import.maxFileMb, но не больше жёсткого потолка (D-112). */
export async function uploadLimitBytes(actor: ImportActor): Promise<number> {
  assertAvailable(actor);
  const ctx = await loadImportContext(actor.spaceId);
  return limitsFor(ctx.settings).maxBytes;
}
