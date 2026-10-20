// Участники раздачи: статус сегодня, нагрузка, остаток лимита.
import { route } from '@/server/access';
import { listParticipants } from '@/server/domain/distribution';
import { respond } from '../_lib';

export const GET = route({ perm: 'pool.read' }, ({ viewer }) => respond(() => listParticipants(viewer)));
