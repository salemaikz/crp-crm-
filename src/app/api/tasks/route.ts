import { route } from '@/server/access';
import { createTask, createTaskBody, listTasks, parseListTasksQuery } from '@/server/domain/tasks';
import { readBody } from './_lib';

// Список задач (B7): вкладки mine / team / unassigned / done, `clientId` — открытые задачи клиента для карточки.
export const GET = route({ perm: 'task.read', target: 'section' }, async ({ req, viewer }) =>
  listTasks(viewer, parseListTasksQuery(new URL(req.url).searchParams)),
);

// Ручная задача: `opId` — id задачи, повтор возвращает прежнюю. Клиент не виден — 404.
export const POST = route({ perm: 'task.write', target: 'section' }, async ({ req, viewer }) => {
  const b = await readBody(req, createTaskBody);
  return createTask(viewer, { ...b, dealId: b.dealId ?? null });
});
