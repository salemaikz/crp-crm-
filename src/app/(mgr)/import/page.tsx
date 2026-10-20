// Экран «Импорт таблиц»: загрузка файла и список загрузок. Только import.run (РОП); модуль выключен — 404.
import { page } from '@/server/access';
import { importService, listProfiles, MAX_LIST } from '@/server/domain/import';
import { actorOf } from './actor';
import { ImportScreen } from './ImportScreen';
import type { ImportListItem, ProfileOption } from './types';

export default page({ perm: 'import.run' }, async ({ viewer }) => {
  const actor = actorOf(viewer);
  const items: ImportListItem[] = await importService.listImports(actor, MAX_LIST);
  const profiles: ProfileOption[] = await listProfiles(actor);
  return <ImportScreen items={items} profiles={profiles} today={viewer.today} />;
});
