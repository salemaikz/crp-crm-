// Отписать устройство: подписки этой сессии и своя подписка с этим адресом. Часть выхода на общем телефоне, поэтому
// мутация безопасности (D-054): работает и при лицензии «только чтение».
import { route } from '@/server/access';
import { unsubscribePush } from '@/server/domain/notify';
import { currentSessionId, readJson, UnsubscribeBody } from '../_lib';

export const POST = route({ perm: 'authenticated', securityMutation: 'auth.logout' }, async ({ req, viewer }) => {
  const body = await readJson(req, UnsubscribeBody);
  return unsubscribePush(viewer, await currentSessionId(), body.endpoint);
});
