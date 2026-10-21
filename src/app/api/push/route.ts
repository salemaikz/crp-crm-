// Доступен ли push на этом устройстве, ключ сервера и привязана ли подписка к этой сессии (D-328). Причины
// недоступности сотруднику не раскрываются.
import { route } from '@/server/access';
import { pushStatus } from '@/server/domain/notify';
import { currentSessionId } from './_lib';

export const GET = route({ perm: 'authenticated' }, async ({ viewer }) => pushStatus(viewer, await currentSessionId()));
