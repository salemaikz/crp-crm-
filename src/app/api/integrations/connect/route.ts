import { pluginDeps } from '@/integrations/registry';
import { route } from '@/server/access';
import { connectIntegration } from '@/server/domain/integrations';
import { ConnectBody, readJson, respond } from '../_lib';

// Подключение по ключу: секрет шифруется, провайдеру уходит только ключ (проверка каналов). Ключ в ответ не возвращается.
// Аудит `integration.connect` пишет домен после успеха.
export const POST = route({ perm: 'admin' }, ({ req, viewer }) =>
  respond(async () => {
    const body = await readJson(req, ConnectBody);
    return connectIntegration(viewer, pluginDeps(), body);
  }),
);
