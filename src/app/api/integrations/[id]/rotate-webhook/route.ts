import { pluginDeps } from '@/integrations/registry';
import { route } from '@/server/access';
import { rotateIntegrationWebhook } from '@/server/domain/integrations';
import { idParam, respond } from '../../_lib';

// Перевыпустить адрес вебхука: старый перестаёт работать; включённое подключение подписывается заново.
export const POST = route({ perm: 'admin', securityMutation: 'integration.revoke_webhook' }, ({ params, viewer }) =>
  respond(async () => rotateIntegrationWebhook(viewer, pluginDeps(), idParam(params.id))),
);
