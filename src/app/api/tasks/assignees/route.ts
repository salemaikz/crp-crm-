import { BadRequestError, route } from '@/server/access';
import { listAssignees } from '@/server/domain/tasks';

// Кому можно назначить задачу по клиенту: я; с task.assign_others — владелец, временный, сотрудники, консультанты.
export const GET = route({ perm: 'task.write', target: 'section' }, async ({ req, viewer }) => {
  const clientId = new URL(req.url).searchParams.get('clientId');
  if (!clientId || clientId.length > 100) throw new BadRequestError('clientId');
  return { items: await listAssignees(viewer, clientId) };
});
