// Задачи (B7): одна страница для всех ролей — оболочку выбирает RoleShell по роли (две группы на один URL
// роняют next build). Первая вкладка «Мои» приходит со страницей; остальное — через /api/tasks.
import type { ReactNode } from 'react';
import { can, page } from '@/server/access';
import { listTaskStaff, listTasks, seesTeam } from '@/server/domain/tasks';
import { TasksScreen } from './_ui/TasksScreen';

export default page<unknown, ReactNode>({ perm: 'task.read' }, async ({ viewer }) => {
  const team = seesTeam(viewer);
  const [initial, staff] = await Promise.all([listTasks(viewer, { view: 'mine' }), team ? listTaskStaff(viewer) : Promise.resolve([])]);
  return (
    <TasksScreen
      initial={initial}
      staff={staff}
      meId={viewer.userId}
      timeZone={viewer.timeZone}
      can={{
        team,
        create: !viewer.readOnly && can(viewer, 'task.write'),
        callbacks: can(viewer, 'card.outcome'),
        remind: can(viewer, 'booking.read'),
      }}
    />
  );
});
