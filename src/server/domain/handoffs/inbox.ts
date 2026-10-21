// Входящие передачи (B6b, docs/deals-handoffs-design.md §7): список, карточка и сотрудники отдела для назначения.
// Охват — отношения главы отдела и исполнителя плюс роли РОП и директора; чужое = несуществующее (404).
import { NotFoundError } from '@/server/access';
import { requirePurchases, requireSpace } from '@/server/domain/deals/guards';
import { getDb } from '@/server/platform/db';
import { dealsDeps } from '@/server/domain/deals/deps';
import { findHandoffScoped, listHandoffsScoped, listTeamMembersScoped, type HandoffRow } from './repo.inbox';
import type { GetHandoff, HandoffStatus, HandoffView, ListHandoffMembers, ListHandoffs } from './types';

const DEFAULT_STATUSES: readonly HandoffStatus[] = ['pending', 'accepted'];
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 200;

/** Строка → проекция: текст отказа только у `declined`; суммы сделки в проекции нет. */
export function toHandoffView(r: HandoffRow, now: number): HandoffView {
  return {
    id: r.id,
    status: r.status,
    teamId: r.teamId,
    teamKey: r.teamKey,
    dealId: r.dealId,
    clientId: r.clientId,
    clientName: r.clientName,
    serviceTypeKey: r.serviceTypeKey,
    wonAt: r.wonAt,
    sellerName: r.sellerName,
    assigneeUserId: r.assigneeUserId,
    assigneeName: r.assigneeName,
    dueAt: r.dueAt,
    overdue: r.status === 'pending' && r.dueAt < now,
    acceptedAt: r.acceptedAt,
    createdAt: r.createdAt,
    declinedReason: r.status === 'declined' && r.declinedReason !== '' ? r.declinedReason : null,
    can: { accept: r.canAccept, decline: r.canAccept, assign: r.canAssign },
  };
}

export const listHandoffs: ListHandoffs = async (viewer, filter) => {
  requirePurchases();
  requireSpace(viewer);
  const db = await getDb();
  const statuses = filter.statuses && filter.statuses.length > 0 ? filter.statuses : DEFAULT_STATUSES;
  const limit = Math.min(Math.max(1, Math.trunc(filter.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const rows = await listHandoffsScoped(viewer, db.sql, { statuses, limit });
  const now = dealsDeps().now();
  return rows.map((r) => toHandoffView(r, now));
};

export const getHandoff: GetHandoff = async (viewer, handoffId) => {
  requirePurchases();
  requireSpace(viewer);
  const db = await getDb();
  const row = await findHandoffScoped(viewer, db.sql, { id: handoffId });
  if (!row) throw new NotFoundError();
  return toHandoffView(row, dealsDeps().now());
};

export const listHandoffMembers: ListHandoffMembers = async (viewer, handoffId) => {
  requirePurchases();
  requireSpace(viewer);
  const db = await getDb();
  const members = await listTeamMembersScoped(viewer, db.sql, handoffId);
  if (!members) throw new NotFoundError();
  return members;
};
