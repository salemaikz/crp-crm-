import { route } from '@/server/access';
import { listClients, parseListQuery } from '@/server/domain/clients';

// Список клиентов текущего пространства: поиск, состояния, фильтры полей. Охват — по карточкам сотрудника.
export const GET = route({ perm: 'client.read', target: 'section' }, async ({ req, viewer }) =>
  listClients(viewer, parseListQuery(new URL(req.url).searchParams)),
);
