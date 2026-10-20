// GET — страница строк предпросмотра по фильтру (?filter&offset&limit ≤ 200).
import { route } from '@/server/access';
import { importService } from '@/server/domain/import';
import { actorOf, guarded, idOf, queryOf, RowsQuery } from '../../_lib';

export const GET = route({ perm: 'import.run' }, ({ req, params, viewer }) =>
  guarded(async () => importService.listRows(actorOf(viewer), idOf(params), RowsQuery.parse(queryOf(req)), Date.now())),
);
