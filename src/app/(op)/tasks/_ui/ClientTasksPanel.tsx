'use client';

import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, EmptyState, List } from '@/ui/kit';
import { call, type ErrorKey } from './api';
import { NewTaskSheet } from './NewTaskSheet';
import { TaskRowItem } from './TaskRowItem';
import { TaskSheet } from './TaskSheet';
import type { TaskList } from './types';

type Props = { clientId: string; clientName: string; canCreate: boolean; meId: string; timeZone: string };

/**
 * Открытые задачи клиента для карточки (тот же GET /api/tasks?clientId=) и «+ Задача» с этим клиентом.
 * Подключается в карточке одной строкой; нужен ToastProvider выше (есть в ClientsProviders).
 */
export function ClientTasksPanel({ clientId, clientName, canCreate, meId, timeZone }: Props) {
  const t = useTranslations('tasks');
  const [list, setList] = useState<TaskList | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const client = useMemo(() => ({ id: clientId, name: clientName }), [clientId, clientName]);

  const load = useCallback(async () => {
    const r = await call<TaskList>('GET', `/api/tasks?clientId=${encodeURIComponent(clientId)}`);
    if (r.ok) {
      setList(r.data);
      setError(null);
    } else setError(r.key);
  }, [clientId]);

  // Первое чтение: результат приходит в колбэке (без setState в теле эффекта)
  useEffect(() => {
    let alive = true;
    void call<TaskList>('GET', `/api/tasks?clientId=${encodeURIComponent(clientId)}`).then((r) => {
      if (!alive) return;
      if (r.ok) setList(r.data);
      else setError(r.key);
    });
    return () => {
      alive = false;
    };
  }, [clientId]);

  return (
    <Card as="section" aria-labelledby="client-tasks-title" data-testid="client-tasks">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="client-tasks-title" className="text-lg font-semibold">
          {t('panel.title')}
        </h2>
        {canCreate && (
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" />
            {t('actions.newTask')}
          </Button>
        )}
      </div>
      {error && <Alert tone="danger">{t(`errors.${error}`)}</Alert>}
      {list && list.items.length === 0 && <EmptyState title={t('empty.client')} framed={false} headingLevel="h3" />}
      {list && list.items.length > 0 && (
        <List aria-labelledby="client-tasks-title">
          {list.items.map((task) => (
            <TaskRowItem key={task.id} task={task} timeZone={timeZone} showAssignee onOpen={(x) => setOpenId(x.id)} />
          ))}
        </List>
      )}
      <TaskSheet
        key={openId ?? 'none'}
        taskId={openId}
        meId={meId}
        timeZone={timeZone}
        onClose={() => setOpenId(null)}
        onChanged={() => void load()}
        onCreateNext={() => {
          setOpenId(null);
          setCreating(true);
        }}
      />
      {creating && <NewTaskSheet open client={client} timeZone={timeZone} onClose={() => setCreating(false)} onCreated={() => void load()} />}
    </Card>
  );
}
