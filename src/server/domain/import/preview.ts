// Предпросмотр для РОП (дизайн C4d §6): сводка «сколько карточек получит каждый оператор», спорные,
// ошибки; блокеры «Применить»; отметка в imports.report.preview (без имён и номеров).
import { imports } from '@crm/core';
import { NotFoundError } from '@/server/access/errors';
import type { Sql } from '@/server/platform/db/core';
import { ImportError } from './errors';
import { blankCard, planImportedCard } from './cardPlan';
import { computePreview, labelRef, memoPhoneHmac, occurredAtOf, ownerLabelsOf, type Computation } from './load';
import { buildId } from './platformGlue';
import * as repo from './repo';
import type { ImportContext } from './settings';
import type { ApplyBlocker, ImportReportV1, OwnerMap, PreviewStamp, PreviewSummary } from './types';

/** Каждый userId карты — активный участник раздачи пространства, иначе 400 bad_owner. */
export async function assertOwners(sql: Sql, ctx: ImportContext, ownerMap: OwnerMap): Promise<repo.Participant[]> {
  const participants = await repo.selectParticipants(sql, ctx.spaceId, ctx.participantRoles);
  const ok = new Set(participants.map((p) => p.userId));
  for (const id of Object.values(ownerMap)) if (id && !ok.has(id)) throw new ImportError('bad_owner');
  return participants;
}

export function loadImportOrThrow(imp: repo.ImportRow | null): repo.ImportRow {
  if (!imp) throw new NotFoundError();
  return imp;
}

/** Ревизии настроек, на которых сделан разбор, совпадают с текущими (иначе файл надо загрузить заново). */
export function configUnchanged(report: ImportReportV1, ctx: ImportContext): boolean {
  const was = report.input.parseConfigRev;
  return was.global === ctx.rev.global && was.space === ctx.rev.space;
}

export function blockersOf(imp: repo.ImportRow, ctx: ImportContext, rowsPresent: boolean, unmappedSlots: number): ApplyBlocker[] {
  const b: ApplyBlocker[] = [];
  if (imp.status === 'applied') b.push('already_applied');
  if (imp.status === 'failed') b.push('failed');
  if (!rowsPresent) b.push('rows_expired');
  if (!configUnchanged(imp.report, ctx)) b.push('config_changed');
  if (unmappedSlots > 0) b.push('unmapped_slots');
  return b;
}

export function summaryOf(imp: repo.ImportRow, ctx: ImportContext, comp: Computation, participants: readonly repo.Participant[], heldWorking: number, blockers: readonly ApplyBlocker[]): PreviewSummary {
  const names = new Map(participants.map((p) => [p.userId, p.name]));
  const p = comp.preview;
  return {
    importId: imp.id,
    fingerprint: comp.fingerprint,
    counts: p.counts,
    perOperator: Object.entries(p.perOperator)
      .map(([userId, count]) => ({ userId, name: names.get(userId) ?? '', count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ru')),
    unowned: p.unowned,
    unmappedSlots: p.unmappedSlots,
    ruleOverlaps: comp.profile.ownerBy.kind === 'row_ranges' ? imports.ruleOverlaps(comp.profile.ownerBy.slots) : [],
    heldWithWorkingOutcome: heldWorking,
    blockers,
  };
}

export function stampOf(comp: Computation, ctx: ImportContext, actorId: string, heldWorking: number, now: number): PreviewStamp {
  const labels = ownerLabelsOf(comp.profile, comp.rows);
  const ref: Record<string, string> = {};
  for (const l of labels) {
    const id = Object.entries(comp.ownerMap).find(([k]) => imports.normalizeLabel(k) === imports.normalizeLabel(l))?.[1];
    if (id) ref[labelRef(l)] = id;
  }
  const p = comp.preview;
  return {
    fingerprint: comp.fingerprint,
    at: now,
    by: actorId,
    buildId: buildId(),
    configRev: ctx.rev,
    ownerMapRef: ref,
    counts: p.counts,
    perOperator: p.perOperator,
    unowned: p.unowned,
    unmappedSlots: p.unmappedSlots.length,
    heldWithWorkingOutcome: heldWorking,
  };
}

/** Карта владельцев из последнего предпросмотра: ярлык → id по хэшу ярлыка (без имён в отчёте). */
export function restoreOwnerMap(report: ImportReportV1, labels: readonly string[]): OwnerMap {
  const ref = report.preview?.ownerMapRef ?? {};
  const out: Record<string, string> = {};
  for (const l of labels) {
    const id = ref[labelRef(l)];
    if (id) out[l] = id;
  }
  return out;
}

/**
 * Сколько новых строк встанут «новыми» без итога: задержаны или без владельца, а в таблице у них рабочий
 * итог (D-115). Считается тем же планировщиком, что и запись.
 */
export function countHeldWorking(ctx: ImportContext, comp: Computation, imp: repo.ImportRow, now: number): number {
  const hash = memoPhoneHmac();
  const occurredAt = occurredAtOf(imp.report.input.snapshotDay, ctx.timeZone, now);
  let n = 0;
  for (const pr of comp.preview.rows) {
    if (pr.action !== 'create' || (pr.hold === '' && pr.ownerUserId)) continue;
    const row = comp.rowByNo.get(pr.rowNo);
    if (!row?.outcomeKey) continue;
    const allowed = row.workingPhones.filter((d) => !comp.stopHits.has(hash(d)));
    const plan = planImportedCard({
      card: blankCard('x', 'x', null, ''),
      row,
      held: true,
      workingPhones: allowed.length,
      settings: ctx.calling,
      calendar: ctx.calendar,
      occurredAt,
      now,
      importKey: row.rowKey,
    });
    if (plan.deferred) n++;
  }
  return n;
}

export { computePreview };
