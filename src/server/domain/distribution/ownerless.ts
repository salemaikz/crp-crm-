// Раздел «Без владельца (не новые)» (C6b §2.6, D-066): страховочный, в норме пуст. Рабочие карточки без владельца
// (владелец отключён, возврат без получателя и т. п.) РОП назначает вручную; лимит не расходуется (`transfer`, D-039).
import { BadRequestError, type Viewer } from '@/server/access';
import { applyCardEventLocked, loadCallingContext } from '@/server/domain/cards';
import { lockCardScoped } from '@/server/domain/cards/repo';
import { writeAudit } from '@/server/platform/audit';
import { getDb } from '@/server/platform/db';
import { distributionDeps } from './deps';
import { DistributionDomainError } from './errors';
import { requireRole, requireSpace } from './guards';
import { participantStatus } from './participants';
import { decodeCursor, encodeCursor } from './pool';
import { countRunRows, listParticipantRows, lockDistribution, selectOwnerlessPage } from './repo';
import type { OwnerlessAssignInput, OwnerlessAssignResult, OwnerlessPage } from './types';

export async function listOwnerless(viewer: Viewer, input: { cursor: string | null; limit: number }): Promise<OwnerlessPage> {
  requireRole(viewer, 'pool.read');
  const spaceId = requireSpace(viewer);
  const after = decodeCursor(input.cursor);
  const limit = Math.min(Math.max(1, input.limit), 100);
  const db = await getDb();
  const rows = await db.tx((tx) => selectOwnerlessPage(viewer, tx, { spaceId, limit: limit + 1, after }));
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ cardId: r.id, clientId: r.clientId, name: r.name, state: r.state, nextCallAt: r.nextCallAt, version: r.version, createdAt: r.createdAt })),
    next: rows.length > limit && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export async function assignOwnerless(viewer: Viewer, input: OwnerlessAssignInput): Promise<OwnerlessAssignResult> {
  requireRole(viewer, 'card.assign');
  const spaceId = requireSpace(viewer);
  const deps = distributionDeps();
  const now = deps.now();
  const cfg = await deps.config(spaceId, now);
  const today = cfg.calendar.localDay(now);
  const ctx = await loadCallingContext(spaceId, now);
  const items = [...new Map(input.items.map((i) => [i.cardId, i])).values()].sort((a, b) => (a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0));
  if (items.length === 0 || items.length > 100) throw new BadRequestError('items');
  const db = await getDb();
  return db.tx(async (tx): Promise<OwnerlessAssignResult> => {
    await lockDistribution(tx);
    // Повтор того же opId: строки журнала уже есть — прежний итог
    const done = await countRunRows(tx, { spaceId, runId: input.opId });
    if (done > 0) return { assigned: done, skipped: [], replayed: true };

    const me = (await listParticipantRows(tx, { spaceId, roles: cfg.participantRoles, today })).find((r) => r.userId === input.toUserId);
    if (!me) throw new DistributionDomainError('not_participant');
    if (participantStatus(me, today) !== 'working') throw new DistributionDomainError('not_working');

    const skipped: OwnerlessAssignResult['skipped'] = [];
    let assigned = 0;
    for (const item of items) {
      const row = await lockCardScoped(tx, viewer, item.cardId, 'card.assign');
      const snap = row?.snapshot;
      // Карточка уже не в разделе (получила владельца, стала новой или слитой) — пропуск без ошибки
      if (!row || !snap || row.spaceId !== spaceId || snap.ownerUserId !== null || snap.state === 'new' || (snap.holdReason as string) === 'merged') {
        skipped.push({ cardId: item.cardId, reason: 'changed' });
        continue;
      }
      const result = await applyCardEventLocked(
        tx,
        viewer,
        row,
        ctx,
        { type: 'transfer', opId: input.opId, toUserId: input.toUserId, seenVersion: item.version, facts: { toUserActive: true } },
        now,
        { opId: input.opId },
      );
      if (result.status === 'applied') assigned++;
      else skipped.push({ cardId: item.cardId, reason: 'changed' });
    }
    await writeAudit(tx, {
      actorId: viewer.userId,
      action: 'distribution.ownerless_assign',
      entity: 'distribution',
      entityId: input.toUserId,
      spaceId,
      meta: { count: assigned, skipped: skipped.length },
      createdAt: now,
    });
    return { assigned, skipped, replayed: false };
  });
}

