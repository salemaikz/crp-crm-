// Доступен ли push на этом устройстве и ключ сервера для подписки (D-328). Причины недоступности сотруднику не раскрываются.
import { route } from '@/server/access';
import { pushStatus } from '@/server/domain/notify';

export const GET = route({ perm: 'authenticated' }, async ({ viewer }) => pushStatus(viewer));
