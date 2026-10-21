// GET — последние загрузки пространства. Только import.run (РОП).
import { route } from '@/server/access';
import { importApi, MAX_LIST } from '@/server/domain/import';
import { actorOf, guarded } from './_lib';

export const GET = route({ perm: 'import.run' }, ({ viewer }) => guarded(async () => ({ items: await importApi.listImports(actorOf(viewer), MAX_LIST) })));
