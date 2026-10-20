// Колокол: свои уведомления и число непрочитанных. Только сессия: чужих строк в выдаче быть не может.
import { route } from '@/server/access';
import { listMine } from '@/server/domain/notify';
import { ListQuery, readQuery } from './_lib';

export const GET = route({ perm: 'authenticated' }, async ({ req, viewer }) => {
  const q = readQuery(req, ListQuery);
  return listMine(viewer, { cursor: q.cursor ?? null, limit: q.limit ?? 30 });
});
