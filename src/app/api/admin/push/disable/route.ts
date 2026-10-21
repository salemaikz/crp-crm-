// Выключить web-push (D-328): мутация безопасности «выключение интеграции» (D-054) — работает при любой лицензии.
import { route } from '@/server/access';
import { disablePush } from '@/server/domain/notify';

export const POST = route({ perm: 'admin', securityMutation: 'integration.disable' }, async ({ viewer }) => disablePush(viewer));
