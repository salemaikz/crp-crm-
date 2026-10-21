import { pluginDeps } from '@/integrations/registry';
import { publicRoute } from '@/server/access';
import { receiveWebhook } from '@/server/domain/integrations';

// Общий приём вебхуков плагинов (INTEGRATIONS §4, дизайн §7.6): сессии нет, Origin не проверяется (машинный вход).
// Подлинность — токен пути (в БД только sha256) и verify() плагина; идемпотентность и лимиты — в receiveWebhook.
export const dynamic = 'force-dynamic';

const one = (v: string | string[] | undefined): string => (typeof v === 'string' ? v : '');

export const POST = publicRoute({ reason: 'webhook', origin: 'skip' }, ({ req, params }) =>
  receiveWebhook(pluginDeps(), { pluginId: one(params.pluginId), token: one(params.token), req }),
);
