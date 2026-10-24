import { route } from '@/server/access';
import { getClientFeed } from '@/server/domain/clients';
import { pathId } from '../../_support';

// Лента клиента (и слитых в него): страница по курсору, группы через запятую; `group=edits` — история правок,
// `dealId` — лента одной сделки, `limit` — размер страницы 1–20 (превью).
export const GET = route({ perm: 'client.read', target: 'object' }, async ({ req, params, viewer }) => {
  const sp = new URL(req.url).searchParams;
  return getClientFeed(viewer, pathId(params), { cursor: sp.get('cursor'), groups: sp.get('groups'), group: sp.get('group'), dealId: sp.get('dealId'), limit: sp.get('limit') });
});
