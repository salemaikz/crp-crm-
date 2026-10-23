import { route } from '@/server/access';
import { getBoardColumn } from '@/server/domain/cards';
import { parseBoardQuery } from '../../_support';

// «Ещё» колонки доски по ключу (курсор — последняя карточка страницы), а не по смещению (pipeline-v2 §6.2).
export const GET = route({ perm: 'card.read', target: 'section' }, async ({ req, viewer }) => {
  const sp = new URL(req.url).searchParams;
  return getBoardColumn(viewer, { ...parseBoardQuery(sp), column: sp.get('column') ?? '', cursor: sp.get('cursor') });
});
