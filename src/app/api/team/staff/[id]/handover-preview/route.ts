// GET — сводка для диалога «Отключить…»: что получит новый владелец и кто примет дела. Только администратор.
import { route } from '@/server/access';
import { handoverPreview } from '@/server/domain/team';
import { userIdOf } from '../../../_lib';

export const GET = route({ perm: 'admin' }, async ({ params, viewer }) => handoverPreview(viewer, userIdOf(params)));
