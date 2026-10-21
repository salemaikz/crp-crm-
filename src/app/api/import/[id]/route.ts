// GET — загрузка с отчётом, ярлыками для карты владельцев и кандидатами. Чужой или несуществующий id — 404.
import { NotFoundError, route } from '@/server/access';
import { importApi } from '@/server/domain/import';
import { actorOf, guarded, idOf } from '../_lib';

export const GET = route({ perm: 'import.run' }, ({ params, viewer }) =>
  guarded(async () => {
    const details = await importApi.getImport(actorOf(viewer), idOf(params), Date.now());
    if (!details) throw new NotFoundError();
    return details;
  }),
);
