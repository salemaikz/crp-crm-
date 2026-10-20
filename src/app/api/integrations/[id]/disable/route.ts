import { pluginDeps } from '@/integrations/registry';
import { route } from '@/server/access';
import { disableIntegration } from '@/server/domain/integrations';
import { idParam, respond } from '../../_lib';

// Выключить: вебхуки перестают приниматься сразу. Мутация безопасности (D-054): работает и в «только чтение».
export const POST = route({ perm: 'admin', securityMutation: 'integration.disable' }, ({ params, viewer }) =>
  respond(async () => disableIntegration(viewer, pluginDeps(), idParam(params.id))),
);
