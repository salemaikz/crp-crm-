// Подписать это устройство на push сотрудника этой сессии (D-328). Адрес — только push-сервиса браузера (D-329).
import { route } from '@/server/access';
import { subscribePush } from '@/server/domain/notify';
import { currentSessionId, readJson, SubscribeBody } from '../_lib';

export const POST = route({ perm: 'authenticated' }, async ({ req, viewer }) => {
  const body = await readJson(req, SubscribeBody);
  return subscribePush(viewer, await currentSessionId(), body);
});
