import { route } from '@/server/access';
import { dealsDeps, listMine } from '@/server/domain/deals';
import { requirePurchases, respond } from '../_lib';

/**
 * «Мои покупки» (pipeline-v2 §9.5): выигранные сделки, засчитанные зрителю по заслуге (автор первой записи сделки).
 * Раздел, а не объект: отбор — собственный предикат в SQL. Название клиента — только при охвате его карточки.
 */
export const GET = route({ perm: 'deal.read' }, ({ viewer, req }) =>
  respond(async () => {
    requirePurchases();
    return Response.json(await listMine(dealsDeps(), viewer, { cursor: new URL(req.url).searchParams.get('cursor') }), { headers: { 'Cache-Control': 'no-store' } });
  }),
);
