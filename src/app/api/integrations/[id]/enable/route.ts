import { pluginDeps } from '@/integrations/registry';
import { route } from '@/server/access';
import { enableIntegration } from '@/server/domain/integrations';
import { idParam, respond } from '../../_lib';

// Включить: новый адрес вебхука (токен не показывается), подписка у провайдера, сотрудники. Ошибка провайдера → 502.
export const POST = route({ perm: 'admin' }, ({ params, viewer }) => respond(async () => enableIntegration(viewer, pluginDeps(), idParam(params.id))));
