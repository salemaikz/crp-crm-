import { pluginDeps } from '@/integrations/registry';
import { route } from '@/server/access';
import { setIntegrationCrossborder } from '@/server/domain/integrations';
import { CrossborderBody, idParam, readJson, respond } from '../../_lib';

// Отметка «есть письменное решение о передаче данных за рубеж» (D-270); снятие отметки выключает подключение.
export const POST = route({ perm: 'admin' }, ({ req, params, viewer }) =>
  respond(async () => setIntegrationCrossborder(viewer, pluginDeps(), idParam(params.id), await readJson(req, CrossborderBody))),
);
