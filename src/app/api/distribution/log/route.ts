// Журнал раздачи за период (≤ 31 день), сгруппированный по прогону, виду и получателю.
import { route } from '@/server/access';
import { getJournal } from '@/server/domain/distribution';
import { LogQuery, readQuery, respond } from '../_lib';

export const GET = route({ perm: 'pool.read' }, ({ req, viewer }) =>
  respond(async () => {
    const q = readQuery(req, LogQuery);
    return getJournal(viewer, { from: q.from, to: q.to, ...(q.userId ? { userId: q.userId } : {}) });
  }),
);
