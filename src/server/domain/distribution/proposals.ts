// Разбор «Предложить контакт» (docs/tasks-team-design.md §5.4, D-258): предложения со статусом `review` —
// номер был у другого клиента, в стоп-листе, лимит проверок исчерпан или режим раздачи не авто. РОП видит номер
// и название целиком и решает: создать клиента (сразу владелец — предложивший) или отклонить.
import { ConflictError, NotFoundError, type Viewer } from '@/server/access';
import { loadClientsConfig } from '@/server/domain/clients/config';
import { createProposalClient, lockIntake } from '@/server/domain/intake';
import { writeAudit } from '@/server/platform/audit';
import { getDb } from '@/server/platform/db';
import { phoneHmac } from '@/server/platform/hmac';
import { phone as phoneCore } from '@crm/core';
import { distributionDeps } from './deps';
import { requireRole, requireSpace } from './guards';
import {
  digitsStopListed,
  insertSharedPhonePair,
  lockDistribution,
  lockProposal,
  proposerActive,
  resolveProposalRow,
  selectProposalsForReview,
  writeAssignBatch,
} from './repo';

export interface ProposalView {
  id: string;
  /** Цифры номера целиком: РОП видит (ПДн в пределах роли). */
  phone: string;
  name: string;
  userId: string;
  userName: string;
  createdAt: number;
  matchedClientId: string | null;
  matchedName: string | null;
}

export interface ResolveProposalInput {
  opId: string;
  decision: 'create' | 'reject';
}

export interface ResolveProposalResult {
  status: 'created' | 'rejected';
  replayed: boolean;
}

export async function listProposals(viewer: Viewer): Promise<ProposalView[]> {
  requireRole(viewer, 'pool.read');
  const spaceId = requireSpace(viewer);
  const db = await getDb();
  const rows = await db.tx((tx) => selectProposalsForReview(tx, viewer, { spaceId }));
  return rows.map((r) => ({
    id: r.id,
    phone: `+${r.digits}`,
    name: r.name,
    userId: r.userId,
    userName: r.userName,
    createdAt: r.createdAt,
    matchedClientId: r.matchedName === null ? null : r.matchedClientId,
    matchedName: r.matchedName,
  }));
}

/** Блокировки: приём (INTAKE) → раздача (DISTRIBUTION) → строка предложения → карточки. Повтор решения — прежний итог. */
export async function resolveProposal(viewer: Viewer, id: string, input: ResolveProposalInput): Promise<ResolveProposalResult> {
  requireRole(viewer, 'card.assign');
  const spaceId = requireSpace(viewer);
  const deps = distributionDeps();
  const now = deps.now();
  const dcfg = await deps.config(spaceId, now);
  const day = dcfg.calendar.localDay(now);
  const cfg = await loadClientsConfig(viewer);
  const db = await getDb();
  return db.tx(async (tx): Promise<ResolveProposalResult> => {
    await lockIntake(tx);
    await lockDistribution(tx);
    const p = await lockProposal(tx, { spaceId, id });
    if (!p) throw new NotFoundError();
    const wanted = input.decision === 'create' ? 'created' : 'rejected';
    if (p.status !== 'review') {
      if (p.status === wanted) return { status: wanted, replayed: true };
      throw new ConflictError();
    }
    if (input.decision === 'reject') {
      await resolveProposalRow(tx, { id, status: 'rejected', clientId: null, by: viewer.userId, now });
      await writeAudit(tx, { actorId: viewer.userId, action: 'proposal.resolve', entity: 'proposal', entityId: id, spaceId, meta: { decision: 'reject' }, createdAt: now });
      return { status: 'rejected', replayed: false };
    }
    // Номер в стоп-листе клиентом не становится: «не звонить» важнее предложения
    if (await digitsStopListed(tx, phoneHmac(p.digits))) throw new ConflictError();
    const parsed = phoneCore.parsePhone(`+${p.digits}`, cfg.phoneRules);
    const created = await createProposalClient(tx, cfg, {
      spaceId,
      actorId: viewer.userId,
      now,
      name: p.name,
      digits: p.digits,
      phoneKind: parsed?.kind ?? 'mobile',
      ext: parsed?.ext ?? '',
    });
    if (p.matchedClientId) await insertSharedPhonePair(tx, { clientA: created.clientId, clientB: p.matchedClientId, now });
    await resolveProposalRow(tx, { id, status: 'created', clientId: created.clientId, by: viewer.userId, now });
    let assigned = false;
    if (await proposerActive(tx, { spaceId, userId: p.userId })) {
      const written = await writeAssignBatch(tx, viewer, {
        spaceId,
        runId: input.opId,
        kind: 'proposal',
        byOperator: { [p.userId]: [created.cardId] },
        countsToCap: dcfg.settings.capIncludes.includes('proposal'),
        day,
        actorId: viewer.userId,
        now,
      });
      assigned = (written.byOperator[p.userId]?.length ?? 0) > 0;
    }
    await writeAudit(tx, { actorId: viewer.userId, action: 'proposal.resolve', entity: 'proposal', entityId: id, spaceId, meta: { decision: 'create', assigned }, createdAt: now });
    return { status: 'created', replayed: false };
  });
}
