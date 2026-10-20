import { route } from '@/server/access';
import { completeTask, completeTaskBody } from '@/server/domain/tasks';
import { pathId, readBody } from '../../_lib';

// «Готово»: проекции срока и инварианты вручную не закрываются (409 auto_task); повтор — прежний ответ.
export const POST = route({ perm: 'task.write', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const b = await readBody(req, completeTaskBody);
  return completeTask(viewer, id, b.comment === undefined ? {} : { comment: b.comment });
});
