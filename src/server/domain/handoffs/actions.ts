// Действия главы отдела над входящей передачей (B6b, docs/deals-handoffs-design.md §7.3, D-250):
// принять, отклонить (причина обязательна), назначить исполнителя (`pending` принимается тем же действием).
// Блокировка: строка передачи в охвате действия. Повтор — `client_events.id = opId` (вид `handoff.*`).
// Текст причины отказа — ПДн: в ленту, аудит и колокол не попадает.
import { NotFoundError, type Viewer } from '@/server/access';
import { resolveLead } from '@/server/domain/cards';
import { DealDomainError } from '@/server/domain/deals/errors';
import { dealsDeps } from '@/server/domain/deals/deps';
import { requirePurchases, requireSpace } from '@/server/domain/deals/guards';
import type { Sql } from '@/server/platform/db';
import { HandoffDomainError } from './errors';
import { toHandoffView } from './inbox';
import {
  acceptScoped,
  assignScoped,
  declineScoped,
  findHandoffScoped,
  findOpEvent,
  insertHandoffFeedWithId,
  isActiveTeamMember,
  lockHandoffScoped,
  reassignOpenTask,
  type LockedHandoff,
} from './repo.inbox';
import { cancelTasksByKeys, ensureHandoffTask, insertHandoffNotification } from './repo';
import { inHandoffsTx } from './tx';
import { HANDOFF_TASK_KEYS, type AcceptHandoff, type AssignHandoff, type DeclineHandoff, type HandoffView } from './types';

const REASON_MAX = 500;

type Kind = 'handoff.accepted' | 'handoff.declined' | 'handoff.assigned';

/** Ответ после действия: строка в охвате действия уже проверена, поэтому чтение без охвата чтения. */
async function viewAfter(viewer: Viewer, tx: Sql, id: string, now: number): Promise<HandoffView> {
  const row = await findHandoffScoped(viewer, tx, { id, afterAction: true });
  if (!row) throw new NotFoundError();
  return toHandoffView(row, now);
}

/**
 * Повтор действия: событие с этим `opId` уже записано тем же сотрудником по этой передаче → текущее состояние
 * без новых эффектов. Чужой или другого вида `opId` — `request_reused`.
 */
async function replayOf(viewer: Viewer, tx: Sql, a: { opId: string; kind: Kind; handoffId: string; now: number }): Promise<HandoffView | null> {
  const seen = await findOpEvent(tx, a.opId);
  if (!seen) return null;
  if (seen.kind !== a.kind || seen.refId !== a.handoffId || seen.actorId !== viewer.userId) throw new DealDomainError('request_reused');
  return viewAfter(viewer, tx, a.handoffId, a.now);
}

interface Ctx {
  viewer: Viewer;
  tx: Sql;
  h: LockedHandoff;
  opId: string;
  now: number;
}

async function writeFeed(c: Ctx, spaceId: string, kind: Kind, data: Record<string, string | number | boolean | null>): Promise<void> {
  const written = await insertHandoffFeedWithId(c.tx, {
    id: c.opId,
    clientId: c.h.clientId,
    spaceId,
    dealId: c.h.dealId,
    handoffId: c.h.id,
    kind,
    actorId: c.viewer.userId,
    at: c.now,
    data: { handoffId: c.h.id, ...data },
  });
  if (!written) throw new DealDomainError('request_reused');
}

export const acceptHandoff: AcceptHandoff = async (viewer, input) => {
  requirePurchases();
  requireSpace(viewer);
  const now = dealsDeps().now();
  return inHandoffsTx(async (tx) => {
    const args = { opId: input.opId, kind: 'handoff.accepted' as const, handoffId: input.handoffId, now };
    const first = await replayOf(viewer, tx, args);
    if (first) return first;
    const h = await lockHandoffScoped(viewer, tx, { id: input.handoffId, perm: 'handoff.accept' });
    if (!h) {
      const again = await replayOf(viewer, tx, args);
      if (again) return again;
      throw new NotFoundError();
    }
    if (h.status !== 'pending') {
      const again = await replayOf(viewer, tx, args);
      if (again) return again;
      throw new HandoffDomainError('already_handled');
    }
    if (!(await acceptScoped(viewer, tx, { id: h.id, at: now }))) throw new NotFoundError();
    await cancelTasksByKeys(tx, [HANDOFF_TASK_KEYS.accept(h.id), HANDOFF_TASK_KEYS.noLead(h.id)], now);
    await writeFeed({ viewer, tx, h, opId: input.opId, now }, h.spaceIdFrom, 'handoff.accepted', {});
    return viewAfter(viewer, tx, h.id, now);
  });
};

export const declineHandoff: DeclineHandoff = async (viewer, input) => {
  requirePurchases();
  requireSpace(viewer);
  const reason = input.reason.trim();
  if (reason === '') throw new HandoffDomainError('reason_required');
  if (reason.length > REASON_MAX) throw new HandoffDomainError('reason_required');
  const now = dealsDeps().now();
  return inHandoffsTx(async (tx) => {
    const args = { opId: input.opId, kind: 'handoff.declined' as const, handoffId: input.handoffId, now };
    const first = await replayOf(viewer, tx, args);
    if (first) return first;
    const h = await lockHandoffScoped(viewer, tx, { id: input.handoffId, perm: 'handoff.accept' });
    if (!h) {
      const again = await replayOf(viewer, tx, args);
      if (again) return again;
      throw new NotFoundError();
    }
    if (h.status !== 'pending') {
      const again = await replayOf(viewer, tx, args);
      if (again) return again;
      throw new HandoffDomainError('already_handled');
    }
    if (!(await declineScoped(viewer, tx, { id: h.id, reason }))) throw new NotFoundError();
    await cancelTasksByKeys(tx, [HANDOFF_TASK_KEYS.accept(h.id), HANDOFF_TASK_KEYS.noLead(h.id)], now);
    // РОП узнаёт об отказе: задача «проверьте» и колокол. Получатель — руководитель продавца (или любой РОП)
    const lead = await resolveLead(tx, { spaceId: h.spaceIdFrom, ownerUserId: h.ownerUserId, at: now });
    if (lead) {
      await ensureHandoffTask(tx, {
        spaceId: h.spaceIdFrom,
        clientId: h.clientId,
        dealId: h.dealId,
        teamId: h.teamId,
        kind: 'check',
        assigneeUserId: lead,
        dueAt: now,
        sourceKey: HANDOFF_TASK_KEYS.declined(h.id),
        createdBy: viewer.userId,
        at: now,
      });
      await insertHandoffNotification(tx, { userId: lead, kind: 'handoff_declined', handoffId: h.id, dedupeKey: `handoff_declined:${h.id}:${lead}`, at: now });
    } else {
      console.warn('[handoffs] нет получателя задачи об отказе передачи');
    }
    await writeFeed({ viewer, tx, h, opId: input.opId, now }, h.spaceIdFrom, 'handoff.declined', {});
    return viewAfter(viewer, tx, h.id, now);
  });
};

export const assignHandoff: AssignHandoff = async (viewer, input) => {
  requirePurchases();
  const spaceId = requireSpace(viewer);
  const deps = dealsDeps();
  const now = deps.now();
  const settings = await deps.settings(spaceId, now);
  return inHandoffsTx(async (tx) => {
    const args = { opId: input.opId, kind: 'handoff.assigned' as const, handoffId: input.handoffId, now };
    const first = await replayOf(viewer, tx, args);
    if (first) return first;
    const h = await lockHandoffScoped(viewer, tx, { id: input.handoffId, perm: 'handoff.assign' });
    if (!h) {
      const again = await replayOf(viewer, tx, args);
      if (again) return again;
      throw new NotFoundError();
    }
    if (h.status !== 'pending' && h.status !== 'accepted') {
      const again = await replayOf(viewer, tx, args);
      if (again) return again;
      throw new HandoffDomainError('already_handled');
    }
    if (!(await isActiveTeamMember(tx, { userId: input.userId, teamId: h.teamId }))) throw new HandoffDomainError('not_team_member');
    if (!(await assignScoped(viewer, tx, { id: h.id, userId: input.userId, at: now }))) throw new NotFoundError();
    await cancelTasksByKeys(tx, [HANDOFF_TASK_KEYS.accept(h.id), HANDOFF_TASK_KEYS.noLead(h.id)], now);
    // Задача исполнителю — следующий рабочий день с начала окна звонков; уже открытая у другого переходит к новому
    const workKey = HANDOFF_TASK_KEYS.work(h.id);
    const moved = await reassignOpenTask(tx, { sourceKey: workKey, assigneeUserId: input.userId });
    if (!moved) {
      await ensureHandoffTask(tx, {
        spaceId: h.spaceIdFrom,
        clientId: h.clientId,
        dealId: h.dealId,
        teamId: h.teamId,
        kind: 'handoff',
        assigneeUserId: input.userId,
        dueAt: settings.calendar.nextWorkdayAt(now, settings.callWindowStart),
        sourceKey: workKey,
        createdBy: viewer.userId,
        at: now,
      });
    }
    await insertHandoffNotification(tx, { userId: input.userId, kind: 'handoff_assigned', handoffId: h.id, dedupeKey: `handoff_assigned:${h.id}:${input.opId}`, at: now });
    await writeFeed({ viewer, tx, h, opId: input.opId, now }, h.spaceIdFrom, 'handoff.assigned', { assigneeUserId: input.userId });
    return viewAfter(viewer, tx, h.id, now);
  });
};
