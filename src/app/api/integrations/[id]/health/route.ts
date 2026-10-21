import { pluginDeps } from '@/integrations/registry';
import { route } from '@/server/access';
import { checkIntegration } from '@/server/domain/integrations';
import { idParam, respond } from '../../_lib';

// Проверка ключа и обновление списка каналов у провайдера. Данных клиентов провайдеру не передаёт.
export const POST = route({ perm: 'admin' }, ({ params, viewer }) => respond(async () => checkIntegration(viewer, pluginDeps(), idParam(params.id))));
