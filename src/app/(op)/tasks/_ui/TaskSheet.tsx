'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, Badge, BottomSheet, Button, Field, Textarea, TextLink, useToast } from '@/ui/kit';
import { call, type ErrorKey } from './api';
import { formatWhen } from './format';
import { useTaskLabel } from './TaskRowItem';
import type { TaskDetail, TaskRow } from './types';

type Props = {
  taskId: string | null;
  /** Я (для «Взять себе»). */
  meId: string;
  timeZone: string;
  onClose: () => void;
  /** Задача изменилась (готово, отмена, взята, комментарий): перечитать список. */
  onChanged: () => void;
  /** «Создать следующую?» после «Готово» (tasks.askNextStep). */
  onCreateNext: (client: { id: string; name: string | null }) => void;
};

const COMMENT_MAX = 2000;

/** Куда ведёт переход из задачи (§4.2): карточка, мастер записи, записи, передача. */
export function actionHref(task: TaskRow): string {
  switch (task.action) {
    case 'book':
      return task.cardId ? `/bookings/new/${task.cardId}` : `/clients/${task.clientId}`;
    case 'openEvent':
    case 'bookings':
      return '/bookings';
    case 'openHandoff':
      return '/handoffs';
    default:
      return `/clients/${task.clientId}`;
  }
}

/**
 * Шторка задачи: детали, комментарии, поле комментария, одна главная кнопка — «Готово» или переход к действию,
 * которое закроет автозадачу. Права приходят с сервера (`can`), интерфейс только показывает.
 */
export function TaskSheet({ taskId, meId, timeZone, onClose, onChanged, onCreateNext }: Props) {
  const t = useTranslations('tasks');
  const label = useTaskLabel();
  const toast = useToast();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [askNext, setAskNext] = useState(false);
  // Шторка монтируется заново на каждую задачу (key у родителя): состояние чистое, opId комментария новый
  const opId = useRef<string>(crypto.randomUUID());

  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    void call<TaskDetail>('GET', `/api/tasks/${encodeURIComponent(taskId)}`).then((r) => {
      if (!alive) return;
      if (r.ok) setDetail(r.data);
      else setError(r.key);
    });
    return () => {
      alive = false;
    };
  }, [taskId]);

  async function reload(id: string) {
    const r = await call<TaskDetail>('GET', `/api/tasks/${encodeURIComponent(id)}`);
    if (r.ok) setDetail(r.data);
  }

  async function act(kind: 'done' | 'cancel' | 'take') {
    if (!detail || busy) return;
    const id = detail.task.id;
    setBusy(true);
    setError(null);
    const r =
      kind === 'done'
        ? await call<{ task: TaskRow; askNext: boolean }>('POST', `/api/tasks/${encodeURIComponent(id)}/done`, {})
        : kind === 'cancel'
          ? await call<{ task: TaskRow }>('POST', `/api/tasks/${encodeURIComponent(id)}/cancel`, {})
          : await call<{ task: TaskRow }>('PATCH', `/api/tasks/${encodeURIComponent(id)}`, { assigneeUserId: meId });
    setBusy(false);
    if (!r.ok) return setError(r.key);
    onChanged();
    if (kind === 'done') {
      toast.show({ message: t('toast.done'), tone: 'success' });
      if ((r.data as { askNext?: boolean }).askNext) {
        setAskNext(true);
        return;
      }
      return onClose();
    }
    if (kind === 'cancel') {
      toast.show({ message: t('toast.cancelled'), tone: 'success' });
      return onClose();
    }
    toast.show({ message: t('toast.taken'), tone: 'success' });
    await reload(id);
  }

  async function comment(e: FormEvent) {
    e.preventDefault();
    if (!detail || busy) return;
    const body = text.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    const r = await call('POST', `/api/tasks/${encodeURIComponent(detail.task.id)}/comments`, { opId: opId.current, body });
    setBusy(false);
    if (!r.ok) {
      if (r.key !== 'network') opId.current = crypto.randomUUID();
      return setError(r.key);
    }
    opId.current = crypto.randomUUID();
    setText('');
    toast.show({ message: t('toast.comment'), tone: 'success' });
    onChanged();
    await reload(detail.task.id);
  }

  const task = detail?.task ?? null;
  const open = task?.status === 'open';
  const primary =
    !task || askNext ? null : detail?.can.done ? (
      <Button block onClick={() => void act('done')} disabled={busy}>
        {t('actions.done')}
      </Button>
    ) : open ? (
      <Button block href={actionHref(task)}>
        {t(`actions.${task.action === 'done' ? 'openCard' : task.action}`)}
      </Button>
    ) : null;

  const footer = askNext && task ? (
    <div className="flex flex-col gap-2">
      <Button block onClick={() => onCreateNext({ id: task.clientId, name: task.clientName })}>
        {t('actions.createNext')}
      </Button>
      <Button block variant="quiet" onClick={onClose}>
        {t('actions.close')}
      </Button>
    </div>
  ) : primary ? (
    <div className="flex flex-col gap-2">
      {primary}
      {detail?.can.take && (
        <Button block variant="secondary" onClick={() => void act('take')} disabled={busy}>
          {t('actions.take')}
        </Button>
      )}
      {detail?.can.cancel && (
        <Button block variant="quiet" onClick={() => void act('cancel')} disabled={busy}>
          {t('actions.cancel')}
        </Button>
      )}
    </div>
  ) : undefined;

  return (
    <BottomSheet open={taskId !== null} onClose={onClose} title={task ? label(task) : t('detail.loading')} closeLabel={t('actions.close')} footer={footer}>
      {error && <Alert tone="danger">{t(`errors.${error}`)}</Alert>}
      {askNext && <p className="mb-2">{t('toast.askNext')}</p>}
      {task && !askNext && (
        <div className="flex flex-col gap-3" data-testid="task-detail">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-[var(--text-2)]">{t('form.client')}</dt>
            <dd>
              {task.cardId || task.clientName ? (
                <TextLink href={`/clients/${task.clientId}`}>{task.clientName ?? t('row.clientHidden')}</TextLink>
              ) : (
                t('row.clientHidden')
              )}
            </dd>
            <dt className="text-[var(--text-2)]">{t('form.kind')}</dt>
            <dd>{t(`kind.${task.kind}`)}</dd>
            <dt className="text-[var(--text-2)]">{t('form.due')}</dt>
            <dd>
              {task.dueAt === null ? t('row.noDue') : formatWhen(task.dueAt, timeZone)}
              {open && task.bucket === 'overdue' && (
                <Badge tone="danger" className="ml-2">
                  {t('row.overdue')}
                </Badge>
              )}
            </dd>
            <dt className="text-[var(--text-2)]">{t('form.assignee')}</dt>
            <dd>{task.assigneeName ?? t('row.unassigned')}</dd>
          </dl>
          {!open && <Badge tone={task.status === 'done' ? 'success' : 'neutral'}>{t(`row.status.${task.status === 'done' ? 'done' : 'cancelled'}`)}</Badge>}
          {task.closable && task.action === 'openCard' && open && (
            <p>
              <TextLink href={`/clients/${task.clientId}`}>{t('actions.openCard')}</TextLink>
            </p>
          )}
          <section aria-labelledby="task-comments-title">
            <h3 id="task-comments-title" className="mb-1 font-semibold">
              {t('detail.comments')}
            </h3>
            {detail && detail.comments.length === 0 ? (
              <p className="text-[var(--text-2)]">{t('detail.noComments')}</p>
            ) : (
              <ul className="flex flex-col divide-y divide-[var(--border)]">
                {detail?.comments.map((c) => (
                  <li key={c.id} className="py-2" data-testid="task-comment">
                    <p className="break-words whitespace-pre-wrap">{c.body}</p>
                    <p className="text-sm text-[var(--text-2)]">
                      {formatWhen(c.createdAt, timeZone)}
                      {c.authorName ? ` · ${c.authorName}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {detail?.can.comment && (
            <form onSubmit={comment} className="flex flex-col gap-2" noValidate>
              <Field label={t('detail.commentLabel')}>
                <Textarea name="taskComment" rows={2} maxLength={COMMENT_MAX} value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
              <div>
                <Button type="submit" variant="secondary" disabled={busy || text.trim().length === 0}>
                  {t('actions.comment')}
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </BottomSheet>
  );
}
