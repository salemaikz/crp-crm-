// Отметить свои уведомления прочитанными (все или по id). Чужие id молча пропускаются.
import { route } from '@/server/access';
import { markMineRead } from '@/server/domain/notify';
import { ReadBody, readJson } from '../_lib';

export const POST = route({ perm: 'authenticated' }, async ({ req, viewer }) => {
  const body = await readJson(req, ReadBody);
  return markMineRead(viewer, 'all' in body ? null : body.ids);
});
