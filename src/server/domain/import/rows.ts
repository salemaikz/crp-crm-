// Строки предпросмотра и отчёта (дизайн C4d §6.3, §13): пересчёт с картой владельцев из последнего
// предпросмотра, фильтр, страница и CSV-выгрузка. ПДн видит только обладатель import.run своего пространства.
import { imports } from '@crm/core';
import { toExcelCsv } from '@/server/platform/files';
import { computePreview, ownerLabelsOf, type Computation } from './load';
import { restoreOwnerMap } from './preview';
import * as repo from './repo';
import type { ImportContext } from './settings';
import type { ImportRowView, RowFilter } from './types';
import type { Sql } from '@/server/platform/db/core';

const HOLDS = new Set(['dup_pair', 'import_conflict', 'no_working_phone']);
const REVIEW_EXTRA = new Set<string>(Object.values(imports.DUPLICATE_ISSUES));

function needsReview(pr: imports.PreviewRow, row: imports.ParsedRow): boolean {
  return row.issues.some((i) => i.severity !== 'info') || pr.issues.some((c) => REVIEW_EXTRA.has(c));
}

export function matches(filter: RowFilter, pr: imports.PreviewRow, row: imports.ParsedRow): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'held':
      return pr.action === 'create' && pr.hold !== '';
    case 'unowned':
      return pr.action === 'create' && pr.hold === '' && !pr.ownerUserId;
    case 'need_review':
      return needsReview(pr, row);
    case 'note_flag':
      return pr.noteFlags.length > 0;
    case 'agreed_without_booking':
      return pr.agreedWithoutBooking;
    default:
      return HOLDS.has(filter) ? pr.action === 'create' && pr.holds.includes(filter as imports.HoldReason) : pr.action === filter;
  }
}

function viewOf(pr: imports.PreviewRow, row: imports.ParsedRow, comp: Computation): ImportRowView {
  const ownerBy = comp.profile.ownerBy;
  const slot = ownerBy.kind === 'row_ranges' ? imports.resolveOwner(row.rowNo, null, ownerBy, {}) : null;
  const label = ownerBy.kind === 'column' ? row.operatorLabel : slot && 'slots' in slot ? (slot.slots[0] ?? null) : null;
  return {
    rowNo: row.rowNo,
    name: row.name,
    phones: row.phones.map((p) => p.raw),
    operatorLabel: label,
    outcomeKey: row.outcomeKey,
    answerRaw: row.answer.raw,
    action: pr.action,
    hold: pr.hold,
    ownerUserId: pr.ownerUserId,
    issues: pr.issues,
    noteFlags: pr.noteFlags,
    clientId: pr.matchId && !pr.matchId.startsWith('row:') ? pr.matchId : null,
  };
}

/** Строки по фильтру с картой владельцев из последнего предпросмотра. null — строки удалены по сроку. */
export async function filteredRows(sql: Sql, ctx: ImportContext, imp: repo.ImportRow, filter: RowFilter): Promise<ImportRowView[] | null> {
  const stored = await repo.selectRows(sql, imp.id);
  if (stored.length === 0) return null;
  const profile = ctx.settings.profiles.find((p) => p.key === imp.profileKey);
  if (!profile) return null;
  const labels = profile.ownerBy.kind === 'row_ranges' ? ownerLabelsOf(profile, []) : await repo.selectOperatorLabels(sql, imp.id);
  const saved = restoreOwnerMap(imp.report, labels);
  const comp = await computePreview(sql, ctx, imp, stored, saved);
  const out: ImportRowView[] = [];
  for (const pr of comp.preview.rows) {
    const row = comp.rowByNo.get(pr.rowNo);
    if (row && matches(filter, pr, row)) out.push(viewOf(pr, row, comp));
  }
  return out;
}

export function csvOf(rows: readonly ImportRowView[], headers: readonly string[]): string {
  return toExcelCsv([
    [...headers],
    ...rows.map((r) => [r.rowNo, r.name, r.phones.join(', '), r.operatorLabel, r.outcomeKey, r.answerRaw, r.action, r.hold, r.issues.join(', '), r.noteFlags.join(', ')]),
  ]);
}
