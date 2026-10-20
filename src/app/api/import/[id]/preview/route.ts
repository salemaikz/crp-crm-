// POST — предпросмотр: «сколько карточек получит каждый оператор», спорные, ошибки, отпечаток.
import { route } from '@/server/access';
import { importService } from '@/server/domain/import';
import { actorOf, guarded, idOf, PreviewBody, readJson } from '../../_lib';

export const POST = route({ perm: 'import.run' }, ({ req, params, viewer }) =>
  guarded(async () => importService.preview(actorOf(viewer), idOf(params), await readJson(req, PreviewBody), Date.now())),
);
