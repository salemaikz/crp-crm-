'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, MessageSquare } from 'lucide-react';
import { Badge, ListItem } from '@/ui/kit';
import { formatWhen } from './format';
import type { TaskRow } from './types';

/** Подпись задачи: у ручной — заголовок, у автозадачи — из локали по источнику (в задаче нет текста). */
export function useTaskLabel(): (task: Pick<TaskRow, 'source' | 'title'>) => string {
  const t = useTranslations('tasks');
  return (task) => (task.source === 'manual' && task.title ? task.title : t(`source.${task.source}`));
}

type Props = {
  task: TaskRow;
  timeZone: string;
  showAssignee: boolean;
  onOpen: (task: TaskRow) => void;
  /** Строка стоит в группе «Просрочено»: слово не повторяем, срок и так красный. */
  inOverdueGroup?: boolean;
};

/** Строка задачи: подпись, клиент, срок, исполнитель (в «Команде»), комментарии. Просрочка — цвет + значок + слово. */
export function TaskRowItem({ task, timeZone, showAssignee, onOpen, inOverdueGroup }: Props) {
  const t = useTranslations('tasks');
  const label = useTaskLabel()(task);
  const overdue = task.status === 'open' && task.bucket === 'overdue';
  const parts: string[] = [task.clientName ?? t('row.clientHidden')];
  if (task.status === 'open') parts.push(task.dueAt === null ? t('row.noDue') : t('row.due', { date: formatWhen(task.dueAt, timeZone) }));
  else if (task.doneAt !== null) parts.push(t('row.doneAt', { date: formatWhen(task.doneAt, timeZone) }));
  if (showAssignee) parts.push(task.assigneeName ?? t('row.unassigned'));
  return (
    <ListItem
      onClick={() => onOpen(task)}
      title={<span data-testid="task-title">{label}</span>}
      meta={
        <span className={overdue ? 'text-[var(--danger)]' : undefined}>
          {parts.join(' · ')}
          {task.comments > 0 && (
            <span className="ml-2 inline-flex items-center gap-1">
              <MessageSquare aria-hidden="true" size={14} />
              {t('row.comments', { count: task.comments })}
            </span>
          )}
        </span>
      }
      trailing={
        overdue && !inOverdueGroup ? (
          <Badge tone="danger" icon={<AlertTriangle aria-hidden="true" size={14} />}>
            {t('row.overdue')}
          </Badge>
        ) : task.status !== 'open' ? (
          <Badge tone={task.status === 'done' ? 'success' : 'neutral'}>{t(`row.status.${task.status}`)}</Badge>
        ) : undefined
      }
    />
  );
}
