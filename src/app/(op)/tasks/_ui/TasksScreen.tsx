'use client';

import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Field, PageHeader, Select, Tabs, TextLink, ToastProvider } from '@/ui/kit';
import { call, type ErrorKey } from './api';
import { NewTaskSheet } from './NewTaskSheet';
import { TaskListView } from './TaskListView';
import { TaskSheet } from './TaskSheet';
import type { ScreenCan, StaffOption, TaskList, TaskRow, TaskView } from './types';

type Props = { initial: TaskList; can: ScreenCan; staff: StaffOption[]; meId: string; timeZone: string };

/** Одна страница `/tasks` для всех ролей: вкладки, группы по сроку, шторка задачи, «+ Задача». */
export function TasksScreen(props: Props) {
  return (
    <ToastProvider>
      <TasksBody {...props} />
    </ToastProvider>
  );
}

function TasksBody({ initial, can, staff, meId, timeZone }: Props) {
  const t = useTranslations('tasks');
  const [view, setView] = useState<TaskView>('mine');
  const [userId, setUserId] = useState('');
  const [list, setList] = useState<TaskList>(initial);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ client: { id: string; name: string | null } | null } | null>(null);
  const first = useRef(true);

  const load = useCallback(async () => {
    const qs = new URLSearchParams({ view });
    if (view === 'team' && userId) qs.set('userId', userId);
    const r = await call<TaskList>('GET', `/api/tasks?${qs.toString()}`);
    if (r.ok) {
      setList(r.data);
      setError(null);
    } else setError(r.key);
  }, [view, userId]);

  useEffect(() => {
    // Первая вкладка пришла со страницей: не перечитываем её сразу
    if (first.current) {
      first.current = false;
      return;
    }
    void load();
  }, [load]);

  const tabs: TaskView[] = can.team ? ['mine', 'team', 'unassigned', 'done'] : ['mine', 'done'];
  const content = (
    <div className="flex flex-col gap-3">
      {view === 'team' && staff.length > 0 && (
        <Field label={t('filter.staff')}>
          <Select name="taskStaff" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">{t('filter.all')}</option>
            {staff.map((s) => (
              <option key={s.userId} value={s.userId}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {error && <Alert tone="danger">{t(`errors.${error}`)}</Alert>}
      <TaskListView
        list={list}
        grouped={view !== 'done'}
        showAssignee={view === 'team' || view === 'done'}
        timeZone={timeZone}
        emptyText={t(`empty.${view}`)}
        onOpen={(task: TaskRow) => setOpenId(task.id)}
      />
    </div>
  );

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-4 lg:py-6">
      <PageHeader
        title={t('title')}
        lead={t('lead')}
        actions={
          can.create ? (
            <Button onClick={() => setCreating({ client: null })}>
              <Plus aria-hidden="true" />
              {t('actions.newTask')}
            </Button>
          ) : undefined
        }
      />
      {(can.callbacks || can.remind) && (
        <nav className="flex flex-wrap gap-4" aria-label={t('title')}>
          {can.callbacks && <TextLink href="/call">{t('links.callbacks')}</TextLink>}
          {can.remind && <TextLink href="/bookings">{t('links.remind')}</TextLink>}
        </nav>
      )}
      <Tabs
        label={t('tabs.label')}
        value={view}
        onChange={(id) => setView(id as TaskView)}
        items={tabs.map((v) => ({
          id: v,
          label: t(`tabs.${v}`),
          ...(v === view && v !== 'done' ? { count: Object.values(list.counts).reduce((a, b) => a + b, 0) } : {}),
          content: v === view ? content : null,
        }))}
      />
      <TaskSheet
        key={openId ?? 'none'}
        taskId={openId}
        meId={meId}
        timeZone={timeZone}
        onClose={() => setOpenId(null)}
        onChanged={() => void load()}
        onCreateNext={(client) => {
          setOpenId(null);
          setCreating({ client });
        }}
      />
      {creating !== null && (
        <NewTaskSheet
          open
        client={creating?.client ?? null}
        timeZone={timeZone}
        onClose={() => setCreating(null)}
          onCreated={() => void load()}
        />
      )}
    </main>
  );
}
