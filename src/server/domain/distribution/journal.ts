// Журнал раздачи для РОП (PROCESS 7.9): выдачи группируются по прогону, виду и получателю.
import { booking } from '@crm/core';
import { BadRequestError } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { requireRole, requireSpace } from './guards';
import { selectJournal, selectUserNames } from './repo';
import type { GetJournal, JournalRow } from './types';

/** Предел периода журнала, суток. */
export const MAX_JOURNAL_DAYS = 31;

export const getJournal: GetJournal = async (viewer, input) => {
  requireRole(viewer, 'pool.read');
  const spaceId = requireSpace(viewer);
  if (!booking.isLocalDate(input.from) || !booking.isLocalDate(input.to) || input.from > input.to) throw new BadRequestError('window');
  if (booking.addDays(input.from, MAX_JOURNAL_DAYS - 1) < input.to) throw new BadRequestError('window');
  const db = await getDb();
  return db.tx(async (tx): Promise<JournalRow[]> => {
    const rows = await selectJournal(tx, { spaceId, from: input.from, to: input.to, userId: input.userId ?? null });
    const ids = new Set<string>();
    for (const r of rows) for (const id of [r.fromUserId, r.toUserId, r.actorId]) if (id) ids.add(id);
    const names = await selectUserNames(tx, [...ids]);
    return rows.map((r) => ({
      day: r.day,
      at: r.firstAt,
      kind: r.kind,
      runId: r.runId,
      fromUserId: r.fromUserId,
      fromName: r.fromUserId ? (names.get(r.fromUserId) ?? null) : null,
      toUserId: r.toUserId,
      toName: r.toUserId ? (names.get(r.toUserId) ?? null) : null,
      actorId: r.actorId,
      count: r.count,
      countsToCap: r.countsToCap,
    }));
  });
};
