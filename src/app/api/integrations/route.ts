import { route } from '@/server/access';
import { listIntegrations } from '@/server/domain/integrations';
import { pluginDeps } from '@/integrations/registry';

// Плагины с подключением и состояние подключений: флаг, лицензия, пригодность, каналы. Без ключей и адресов вебхука.
export const GET = route({ perm: 'admin' }, ({ viewer }) => listIntegrations(viewer, pluginDeps()));
