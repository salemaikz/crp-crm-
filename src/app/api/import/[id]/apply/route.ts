// POST — применение строго по предпросмотру с тем же отпечатком (D-113). Повтор после успеха — alreadyApplied.
import { route } from '@/server/access';
import { importService } from '@/server/domain/import';
import { actorOf, ApplyBody, guarded, idOf, readJson } from '../../_lib';

export const POST = route({ perm: 'import.run' }, ({ req, params, viewer }) =>
  guarded(async () => importService.apply(actorOf(viewer), idOf(params), await readJson(req, ApplyBody), Date.now())),
);
