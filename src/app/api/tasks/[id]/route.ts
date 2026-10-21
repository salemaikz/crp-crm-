import { route } from '@/server/access';
import { getTask, updateTask, updateTaskBody } from '@/server/domain/tasks';
import { pathId, readBody } from '../_lib';

// Задача с комментариями и тем, что можно сделать. Чужая и несуществующая — одинаковый 404.
export const GET = route({ perm: 'task.read', target: 'object' }, async ({ params, viewer }) => getTask(viewer, pathId(params)));

// Правка: срок и заголовок — только у ручных (409 auto_task), исполнитель — с task.assign_others или «взять себе».
export const PATCH = route({ perm: 'task.write', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const b = await readBody(req, updateTaskBody);
  return updateTask(viewer, id, b);
});
