'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { EmptyState, List } from '@/ui/kit';
import { TaskRowItem } from './TaskRowItem';
import type { TaskBucket, TaskList, TaskRow } from './types';

const ORDER: readonly TaskBucket[] = ['overdue', 'today', 'tomorrow', 'later', 'none'];

type Props = {
  list: TaskList;
  /** Группы по сроку (открытые); false — плоский список (выполненные). */
  grouped: boolean;
  showAssignee: boolean;
  timeZone: string;
  emptyText: string;
  onOpen: (task: TaskRow) => void;
};

/** Список задач группами «Просрочено / Сегодня / Завтра / Позже / Без срока» со счётчиками. */
export function TaskListView({ list, grouped, showAssignee, timeZone, emptyText, onOpen }: Props) {
  const t = useTranslations('tasks');
  if (list.items.length === 0) return <EmptyState title={emptyText} framed={false} headingLevel="h3" />;
  if (!grouped) {
    return (
      <List aria-label={t('title')}>
        {list.items.map((task) => (
          <TaskRowItem key={task.id} task={task} timeZone={timeZone} showAssignee={showAssignee} onOpen={onOpen} />
        ))}
      </List>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {ORDER.map((bucket) => {
        const items = list.items.filter((x) => x.bucket === bucket);
        if (items.length === 0) return null;
        const id = `tasks-bucket-${bucket}`;
        return (
          <section key={bucket} aria-labelledby={id} data-testid={`bucket-${bucket}`}>
            <h2 id={id} className={`mb-1 flex items-center gap-1 text-base font-semibold ${bucket === 'overdue' ? 'text-[var(--danger)]' : ''}`}>
              {bucket === 'overdue' && <AlertTriangle aria-hidden="true" size={16} />}
              {t(`buckets.${bucket}`)} · {list.counts[bucket]}
            </h2>
            <List aria-labelledby={id}>
              {items.map((task) => (
                <TaskRowItem key={task.id} task={task} timeZone={timeZone} showAssignee={showAssignee} onOpen={onOpen} inOverdueGroup={bucket === 'overdue'} />
              ))}
            </List>
          </section>
        );
      })}
      {list.truncated && <p className="text-sm text-[var(--text-2)]">{t('truncated')}</p>}
    </div>
  );
}
