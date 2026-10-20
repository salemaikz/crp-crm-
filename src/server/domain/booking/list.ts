// Минимальные «Записи» (B3a, docs/booking-wizard-design.md §8): только чтение по охвату записи.
// Действия, фильтры и вид РОП — B3b/R1a.
import { BadRequestError } from '@/server/access';
import { booking } from '@crm/core';
import { requireSpace } from './guards';
import { listBookingItemRows, toBookingView } from './repo';
import { inBookingTx } from './tx';
import type { ListBookingItems } from './types';

const LIST_LIMIT = 200;

export const listBookingItems: ListBookingItems = async (_deps, viewer, filter) => {
  const spaceId = requireSpace(viewer);
  if (!booking.isLocalDate(filter.from) || !booking.isLocalDate(filter.to) || filter.from > filter.to) throw new BadRequestError('window');
  const limit = Math.min(Math.max(filter.limit ?? LIST_LIMIT, 1), LIST_LIMIT);
  const rows = await inBookingTx({}, (tx) =>
    listBookingItemRows(viewer, tx, { spaceId, from: filter.from, to: filter.to, statuses: filter.status && filter.status.length > 0 ? filter.status : null, limit }),
  );
  return rows.map((r) => ({ ...toBookingView(r), clientName: r.clientName, grey: r.kind === 'individual' && r.resourceId === null }));
};
