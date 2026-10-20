import { route } from '@/server/access';
import { cancelTask } from '@/server/domain/tasks';
import { pathId } from '../../_lib';

// «Отменить»: только ручная задача, автор или охват пространства.
export const POST = route({ perm: 'task.write', target: 'object' }, async ({ params, viewer }) => cancelTask(viewer, pathId(params)));
