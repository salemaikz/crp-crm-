// «Отсутствует» (C6b, docs/tasks-team-design.md §2.2–§2.4, D-255): создание, отмена, список и применение — сразу и
// ежедневной задачей `absence`. Правила выбора карточек и «поровну» — чистое ядро `distribution`; переход карточки —
// ядро `calling` через общий путь ручных событий (cards/manual.ts). Порядок блокировок: advisory → карточки по id.
import { distribution as core, time } from '@crm/core';
import { BadRequestError, NotFoundError, type SystemActor, type Viewer } from '@/server/access';
import { applyCardEventLocked, resolveLead, loadCallingContext, type CallingContext } from '@/server/domain/cards';
import { lockCardUnscoped } from '@/server/domain/cards/repo';
import { writeAudit } from '@/server/platform/audit';
import { getDb, type Sql } from '@/server/platform/db';
import { distributionDeps } from './deps';
import { DistributionDomainError } from './errors';
import { requireRole, requireSpace } from './guards';
import {
  absenceIdTaken,
  absenceOverlaps,
  cancelAbsenceRow,
  insertAbsence,
  insertCountNotification,
  listParticipantRows,
  loadParticipantLoad,
  lockDistribution,
  memberActive,
  releaseActing,
  selectAbsenceById,
  selectAbsenceCards,
  selectAbsenceRow,
  selectAbsenceViews,
  selectActiveAbsences,
  selectPairsAmong,
  selectSubstituteCandidates,
  type AbsenceRow,
} from './repo';
import type { AbsenceApplied, AbsenceView, CreateAbsenceInput, CreateAbsenceResult, DistributionActor, DistributionConfig } from './types';

/** Длина отсутствия не больше 60 дней (§2.2). */
export const MAX_ABSENCE_DAYS = 60;

const maxDay = (a: string, b: string): string => (a >= b ? a : b);

function daysBetween(from: string, to: string): number {
  const a = time.parseDay(from);
  const b = time.parseDay(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.dayOfMonth) - Date.UTC(a.year, a.month - 1, a.dayOfMonth)) / 86_400_000);
}

const toView = (r: AbsenceView): AbsenceView => ({
  id: r.id,
  userId: r.userId,
  userName: r.userName,
  fromDay: r.fromDay,
  toDay: r.toDay,
  substituteUserId: r.substituteUserId,
  substituteName: r.substituteName,
  createdAt: r.createdAt,
});

/** Группы двойников среди карточек: ключ группы — наименьший `client_id` (как D-174). */
function groupKeys(clientIds: readonly string[], pairs: readonly { aClientId: string; bClientId: string }[]): Map<string, string> {
  const parent = new Map<string, string>(clientIds.map((c) => [c, c]));
  const find = (x: string): string => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) as string;
    return r;
  };
  for (const p of pairs) {
    if (!parent.has(p.aClientId) || !parent.has(p.bClientId)) continue;
    const ra = find(p.aClientId);
    const rb = find(p.bClientId);
    if (ra === rb) continue;
    // корень — наименьший client_id, чтобы ключ группы не зависел от порядка пар
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  }
  return new Map(clientIds.map((c) => [c, find(c)]));
}

export interface ApplyAbsencesInput {
  spaceId: string;
  absence: AbsenceRow;
  today: string;
  now: number;
}

export interface ApplyAbsencesReport extends AbsenceApplied {
  /** Не тронуты: карточка изменилась после выборки или заместителя не нашлось. */
  skipped: number;
}

/**
 * Применить отсутствие к карточкам (§2.4): выбрать, назначить временных, записать переходы. Идемпотентно: карточка с уже
 * заданным временным не выбирается. Вызывать в транзакции под DISTRIBUTION_LOCK_KEY.
 */
export async function applyAbsences(
  tx: Sql,
  actor: DistributionActor,
  input: ApplyAbsencesInput,
  env: { cfg: DistributionConfig; ctx: CallingContext },
): Promise<ApplyAbsencesReport> {
  const { spaceId, absence, today, now } = input;
  const { cfg, ctx } = env;
  const report: ApplyAbsencesReport = { acting: 0, released: 0, skipped: 0 };
  const from = maxDay(absence.fromDay, today);
  const endMs = time.fromLocalTime(time.addLocalDays(absence.toDay, 1), '00:00', cfg.timeZone);

  const rows = await selectAbsenceCards(tx, { spaceId, userId: absence.userId, winFrom: from, winTo: cfg.calendar.nextWorkday(absence.toDay) });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const selected = core.selectAbsenceCards(
    rows.map((r) => ({
      cardId: r.id,
      clientId: r.clientId,
      state: r.state as core.AbsenceCardRow['state'],
      callsTotal: r.callsTotal,
      nextCallAt: r.nextCallAt,
      hasBookingInWindow: r.hasBooking,
      actingUserId: r.actingUserId,
      actingUntilDay: r.actingUntilDay,
    })),
    endMs,
  );
  if (selected.length === 0) return report;

  const clientIds = [...new Set(selected.map((r) => r.clientId))];
  const keys = groupKeys(clientIds, await selectPairsAmong(tx, clientIds));
  const cards: core.ActingCard[] = selected.map((r) => ({
    cardId: r.cardId,
    groupKey: keys.get(r.clientId) ?? r.clientId,
    ...(r.state === 'new' ? { release: true } : {}),
    ...(r.actingUserId !== null ? { untilDay: r.actingUntilDay } : {}),
  }));

  // Кандидаты: заданный заместитель или участники раздачи (поровну); отсутствие, пересекающее период, исключает
  const candidates = await selectSubstituteCandidates(tx, {
    spaceId,
    roles: cfg.participantRoles,
    exceptUserId: absence.userId,
    from,
    to: absence.toDay,
    onlyInDistribution: absence.substituteUserId === null,
  });
  let who: core.ActingWho;
  if (absence.substituteUserId !== null) {
    who = candidates.some((c) => c.userId === absence.substituteUserId) ? { substitute: absence.substituteUserId } : { even: [] };
  } else {
    const load = await loadParticipantLoad(tx, { spaceId, userIds: candidates.map((c) => c.userId), now, today });
    who = { even: candidates.map((c) => ({ userId: c.userId, load: load.get(c.userId)?.open ?? 0 })) };
  }
  const plan = core.planActing(cards, who, absence.toDay);
  const planned = new Set(plan.map((p) => p.cardId));
  const noSubstitute = selected.filter((r) => r.state !== 'new' && !planned.has(r.cardId)).length;
  report.skipped += noSubstitute;

  // Временный стал владельцем карточки (коллеги замещали друг друга): временного просто снимаем
  const toOwner = plan.filter((p) => p.action === 'acting' && p.actingUserId === byId.get(p.cardId)?.ownerUserId).map((p) => p.cardId);
  if (toOwner.length > 0) {
    await releaseActing(tx, { spaceId, scope: { cardIds: toOwner }, today, runId: absence.id, actorId: actor.kind === 'user' ? actor.userId : null, now });
    report.acting += toOwner.length;
  }
  const skipOwner = new Set(toOwner);
  const perUser = new Map<string, number>();
  for (const act of [...plan].sort((a, b) => (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0))) {
    if (skipOwner.has(act.cardId)) continue;
    const sel = byId.get(act.cardId);
    const locked = await lockCardUnscoped(tx, act.cardId);
    if (!sel || !locked || locked.spaceId !== spaceId) {
      report.skipped++;
      continue;
    }
    const snap = locked.snapshot;
    // Карточка могла измениться между выборкой и блокировкой (итог звонка не берёт блокировку раздачи)
    const unchanged = sel.actingUserId === null ? snap.ownerUserId === absence.userId && snap.actingUserId === null : snap.actingUserId === absence.userId;
    if (!unchanged) {
      report.skipped++;
      continue;
    }
    const event =
      act.action === 'release'
        ? ({ type: 'release', opId: absence.id, seenVersion: snap.version } as const)
        : ({ type: 'absence', opId: absence.id, actingUserId: act.actingUserId as string, untilDay: act.untilDay as string } as const);
    const result = await applyCardEventLocked(tx, actor, locked, ctx, event, now, { opId: absence.id });
    if (result.status !== 'applied') {
      report.skipped++;
      continue;
    }
    if (act.action === 'release') report.released++;
    else {
      report.acting++;
      perUser.set(act.actingUserId as string, (perUser.get(act.actingUserId as string) ?? 0) + 1);
    }
  }
  for (const [userId, count] of [...perUser].sort()) {
    await insertCountNotification(tx, { userId, kind: 'absence_acting', count, dedupeKey: `absence:${absence.id}:${userId}:${today}`, now });
  }
  if (noSubstitute > 0) {
    // Заместителя нет: карточки остаются у владельца, руководитель решает вручную (D-255)
    const lead = await resolveLead(tx, { spaceId, ownerUserId: absence.userId, at: now });
    if (lead) await insertCountNotification(tx, { userId: lead, kind: 'absence_no_substitute', count: noSubstitute, dedupeKey: `absence:${absence.id}:no_substitute:${today}`, now });
  }
  return report;
}

function validateDates(input: { fromDay: string; toDay: string }, today: string): void {
  const ok = time.isValidDay(input.fromDay) && time.isValidDay(input.toDay);
  if (!ok || input.fromDay > input.toDay || input.toDay < today || daysBetween(input.fromDay, input.toDay) + 1 > MAX_ABSENCE_DAYS) throw new DistributionDomainError('dates');
}

export async function createAbsence(viewer: Viewer, input: CreateAbsenceInput): Promise<CreateAbsenceResult> {
  requireRole(viewer, 'distribution.manage');
  const spaceId = requireSpace(viewer);
  const deps = distributionDeps();
  const now = deps.now();
  const cfg = await deps.config(spaceId, now);
  const today = cfg.calendar.localDay(now);
  validateDates(input, today);
  const ctx = await loadCallingContext(spaceId, now);
  const db = await getDb();
  return db.tx(async (tx): Promise<CreateAbsenceResult> => {
    await lockDistribution(tx);
    // Повтор того же opId: прежнее отсутствие, ничего не применяем
    const prior = await selectAbsenceById(tx, { spaceId, id: input.opId });
    if (prior) {
      if (prior.createdBy !== viewer.userId || prior.userId !== input.userId) throw new BadRequestError('op_id');
      return { ...toView(prior), applied: { acting: 0, released: 0 }, replayed: true };
    }
    if (await absenceIdTaken(tx, input.opId)) throw new BadRequestError('op_id');
    if (!(await memberActive(tx, { spaceId, userId: input.userId }))) throw new NotFoundError();
    const from = maxDay(input.fromDay, today);
    if (await absenceOverlaps(tx, { spaceId, userId: input.userId, from: input.fromDay, to: input.toDay })) throw new DistributionDomainError('overlap');

    const sub = input.substituteUserId;
    if (sub !== null) {
      if (sub === input.userId) throw new DistributionDomainError('not_participant');
      const participants = await listParticipantRows(tx, { spaceId, roles: cfg.participantRoles, today });
      if (!participants.some((p) => p.userId === sub)) throw new DistributionDomainError('not_participant');
      if (await absenceOverlaps(tx, { spaceId, userId: sub, from, to: input.toDay })) throw new DistributionDomainError('substitute_absent');
    } else {
      const even = await selectSubstituteCandidates(tx, { spaceId, roles: cfg.participantRoles, exceptUserId: input.userId, from, to: input.toDay, onlyInDistribution: true });
      if (even.length === 0) throw new DistributionDomainError('no_substitute');
    }

    await insertAbsence(tx, { id: input.opId, spaceId, userId: input.userId, fromDay: input.fromDay, toDay: input.toDay, substituteUserId: sub, createdBy: viewer.userId, now });
    await writeAudit(tx, {
      actorId: viewer.userId,
      action: 'distribution.absence',
      entity: 'distribution',
      entityId: input.userId,
      spaceId,
      meta: { fromDay: input.fromDay, toDay: input.toDay, even: sub === null },
      createdAt: now,
    });
    const row = await selectAbsenceRow(tx, { spaceId, id: input.opId });
    if (!row) throw new Error('absence: строка не создана');
    const applied: AbsenceApplied =
      input.fromDay <= today ? await applyAbsences(tx, viewer, { spaceId, absence: row, today, now }, { cfg, ctx }) : { acting: 0, released: 0 };
    const view = await selectAbsenceById(tx, { spaceId, id: input.opId });
    if (!view) throw new Error('absence: строка не создана');
    return { ...toView(view), applied: { acting: applied.acting, released: applied.released }, replayed: false };
  });
}

export async function cancelAbsence(viewer: Viewer, id: string): Promise<AbsenceView> {
  requireRole(viewer, 'distribution.manage');
  const spaceId = requireSpace(viewer);
  const deps = distributionDeps();
  const now = deps.now();
  const cfg = await deps.config(spaceId, now);
  const today = cfg.calendar.localDay(now);
  const db = await getDb();
  return db.tx(async (tx) => {
    await lockDistribution(tx);
    const done = await cancelAbsenceRow(tx, { spaceId, id, now });
    const view = await selectAbsenceById(tx, { spaceId, id });
    if (!view) throw new NotFoundError();
    // Уже отменено — прежний ответ, повторно ничего не снимаем
    if (!done) return toView(view);
    await releaseActing(tx, { spaceId, scope: { owner: done.userId }, today, runId: id, actorId: viewer.userId, now });
    await writeAudit(tx, { actorId: viewer.userId, action: 'distribution.absence_cancel', entity: 'distribution', entityId: done.userId, spaceId, meta: {}, createdAt: now });
    return toView(view);
  });
}

export async function listAbsences(viewer: Viewer): Promise<AbsenceView[]> {
  requireRole(viewer, 'pool.read');
  const spaceId = requireSpace(viewer);
  const deps = distributionDeps();
  const now = deps.now();
  const cfg = await deps.config(spaceId, now);
  const db = await getDb();
  const rows = await selectAbsenceViews(db.sql, { spaceId, today: cfg.calendar.localDay(now) });
  return rows.map(toView);
}

export interface AbsenceRunReport {
  /** Карточек, у которых снят временный владелец по сроку. */
  ended: number;
  released: number;
  acting: number;
}

/** Задача `absence` (07:30, по пространству): снять временных по сроку и применить отсутствия, действующие сегодня. */
export async function runAbsences(actor: SystemActor, input: { spaceId: string; runId: string; now: number }): Promise<AbsenceRunReport> {
  const deps = distributionDeps();
  const cfg = await deps.config(input.spaceId, input.now);
  const ctx = await loadCallingContext(input.spaceId, input.now);
  const today = cfg.calendar.localDay(input.now);
  const db = await getDb();
  return db.tx(async (tx) => {
    await lockDistribution(tx);
    const ended = await releaseActing(tx, { spaceId: input.spaceId, scope: { expiredBefore: today }, today, runId: input.runId, actorId: null, now: input.now });
    const out: AbsenceRunReport = { ended, released: 0, acting: 0 };
    for (const absence of await selectActiveAbsences(tx, { spaceId: input.spaceId, today })) {
      const r = await applyAbsences(tx, actor, { spaceId: input.spaceId, absence, today, now: input.now }, { cfg, ctx });
      out.released += r.released;
      out.acting += r.acting;
    }
    return out;
  });
}
