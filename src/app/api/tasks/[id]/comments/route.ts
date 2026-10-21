import { route } from '@/server/access';
import { addComment, commentBody } from '@/server/domain/tasks';
import { pathId, readBody } from '../../_lib';

// Комментарий к задаче: `opId` — id комментария, повтор возвращает прежний. Чужая задача — 404.
export const POST = route({ perm: 'task.write', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const b = await readBody(req, commentBody);
  return addComment(viewer, id, b);
});
