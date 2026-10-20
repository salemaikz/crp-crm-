// Ручная выдача РОП («Раздать выбранные», docs/distribution-design.md §3.2): одна транзакция под DISTRIBUTION_LOCK_KEY.
import { booking, distribution as core } from '@crm/core';
import { writeAudit } from '@/server/platform/audit';
import { getDb } from '@/server/platform/db';
import { distributionDeps } from './deps';
import { DistributionDomainError } from './errors';
import { requireRole, requireSpace } from './guards';
import { participantStatus } from './participants';
import { classifyCandidates, loadCandidates } from './pool';
import { listParticipantRows, loadParticipantLoad, lockDistribution, selectOperationCards, selectPoolCardsByIds, writeAssignBatch } from './repo';
import type { IssueCards, ManualIssueResult, ManualIssueSkip, PoolCandidate } from './types';

export const issueCards: IssueCards = async (viewer, input, deps = distributionDeps()) => {
  requireRole(viewer, 'card.assign');
  const spaceId = requireSpace(viewer);
  const now = deps.now();
  const cfg = await deps.config(spaceId, now);
  const day = cfg.calendar.localDay(now);
  const yesterday = booking.addDays(day, -1);
  const db = await getDb();

  return db.tx(async (tx): Promise<ManualIssueResult> => {
    await lockDistribution(tx);
    const rows = await listParticipantRows(tx, { spaceId, roles: cfg.participantRoles, today: day });
    const me = rows.find((r) => r.userId === input.toUserId);
    const load = (await loadParticipantLoad(tx, { spaceId, userIds: me ? [me.userId] : [], now, today: day })).get(input.toUserId);
    const participant: core.Participant | null = me
      ? { userId: me.userId, status: participantStatus(me, day), open: load?.open ?? 0, openNew: load?.openNew ?? 0, issuedToday: load?.issuedToday ?? {} }
      : null;
    const remainingOf = (p: core.Participant) => core.capRemaining(p, cfg.settings);

    // Повтор того же opId: возвращаем записанное, ничего не делаем.
    const done = await selectOperationCards(tx, { spaceId, opId: input.opId, days: [day, yesterday] });
    if (done.length > 0) {
      return {
        issued: done.map((r) => r.cardId),
        skipped: [],
        remaining: participant ? remainingOf(participant) : 0,
        cap: cfg.settings.dailyCap,
        replayed: true,
      };
    }

    if (cfg.settings.mode === 'off') throw new DistributionDomainError('mode_off');
    if (!participant) throw new DistributionDomainError('not_participant');
    if (core.checkManualIssue(participant, 0, cfg.settings).reason === 'not_working') throw new DistributionDomainError('not_working');

    const skipped: { cardId: string; reason: ManualIssueSkip }[] = [];
    let candidates: PoolCandidate[];
    if (input.cardIds) {
      const ids = [...new Set(input.cardIds)];
      const inPool = await selectPoolCardsByIds(viewer, tx, { spaceId, ids, perm: 'card.assign' });
      const present = new Set(inPool.map((r) => r.id));
      for (const id of ids) if (!present.has(id)) skipped.push({ cardId: id, reason: 'not_in_pool' });
      candidates = await classifyCandidates(tx, spaceId, inPool);
    } else {
      candidates = await loadCandidates(viewer, tx, { spaceId, limit: input.count ?? 0, perm: 'card.assign' });
    }

    // Лимит ручной выдачи: не входит в состав лимита или разрешено сверх — не ограничиваем (PROCESS 7.3).
    const capped = cfg.settings.capIncludes.includes('manual') && !cfg.settings.capOverride;
    const planSettings = capped ? cfg.settings : { ...cfg.settings, dailyCap: Number.MAX_SAFE_INTEGER };
    const plan = core.planAllocation([participant], candidates, planSettings, { mobileFirst: false });
    if (plan.overCap.length > 0) throw new DistributionDomainError('over_cap', { remaining: remainingOf(participant), cap: cfg.settings.dailyCap });
    for (const id of plan.heldBack) skipped.push({ cardId: id, reason: 'pair_held' });
    for (const id of plan.blocked) skipped.push({ cardId: id, reason: 'pair_blocked' });

    const planned = plan.byOperator[input.toUserId] ?? [];
    let issued: string[] = [];
    if (planned.length > 0) {
      const written = await writeAssignBatch(tx, viewer, {
        spaceId,
        runId: input.opId,
        kind: 'manual',
        byOperator: { [input.toUserId]: planned },
        countsToCap: cfg.settings.capIncludes.includes('manual'),
        day,
        actorId: viewer.userId,
        now,
      });
      issued = written.byOperator[input.toUserId] ?? [];
      for (const id of written.raced) skipped.push({ cardId: id, reason: 'raced' });
      await writeAudit(tx, {
        actorId: viewer.userId,
        action: 'distribution.issue',
        entity: 'distribution',
        entityId: input.toUserId,
        spaceId,
        meta: { count: issued.length, skipped: skipped.length },
        createdAt: now,
      });
    }
    const after: core.Participant = { ...participant, issuedToday: { ...participant.issuedToday, manual: (participant.issuedToday.manual ?? 0) + issued.length } };
    return { issued, skipped, remaining: remainingOf(after), cap: cfg.settings.dailyCap, replayed: false };
  });
};
