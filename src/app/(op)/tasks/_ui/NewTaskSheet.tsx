'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Alert, BottomSheet, Button, Chip, ChipGroup, Field, Input, Select, useToast } from '@/ui/kit';
import { addDays, fromInputValue, fromLocal, localDay } from '@/ui/call/zoned';
import { call, type ErrorKey } from './api';
import type { TaskAssignee, TaskRow } from './types';

type ClientRef = { id: string; name: string | null };

type Props = {
  open: boolean;
  onClose: () => void;
  /** Клиент задан (карточка клиента, «Создать следующую»); null — поиск своего клиента. */
  client: ClientRef | null;
  timeZone: string;
  onCreated: (task: TaskRow) => void;
};

const KINDS = ['call', 'message', 'meeting', 'check', 'other'] as const;
type Kind = (typeof KINDS)[number];
type Quick = 'today' | 'tomorrow' | 'custom' | 'none';

/** Срок по быстрой кнопке в поясе установки: «Сегодня 18:00», «Завтра 10:00». Проверяет сервер. */
function quickDue(q: Quick, custom: string, tz: string): number | null {
  const today = localDay(Date.now(), tz);
  if (q === 'today') return fromLocal(today, '18:00', tz);
  if (q === 'tomorrow') return fromLocal(addDays(today, 1), '10:00', tz);
  if (q === 'custom') return fromInputValue(custom, tz);
  return null;
}

/**
 * Новая ручная задача: клиент (задан или поиск своего), тип, что сделать, срок (быстрые «Сегодня 18:00»,
 * «Завтра 10:00», своё, без срока), исполнитель (список с сервера, по умолчанию я). `opId` живёт до успеха:
 * повтор при сбое сети не создаёт вторую задачу.
 */
export function NewTaskSheet({ open, onClose, client, timeZone, onCreated }: Props) {
  const t = useTranslations('tasks');
  const toast = useToast();
  const [picked, setPicked] = useState<ClientRef | null>(client);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<ClientRef[] | null>(null);
  const [kind, setKind] = useState<Kind>('call');
  const [title, setTitle] = useState('');
  const [quick, setQuick] = useState<Quick>('today');
  const [custom, setCustom] = useState('');
  const [assignees, setAssignees] = useState<TaskAssignee[]>([]);
  const [assignee, setAssignee] = useState('');
  const [error, setError] = useState<ErrorKey | null>(null);
  const [busy, setBusy] = useState(false);
  // Шторка монтируется заново на каждое открытие (key у родителя): форма чистая, opId новый
  const opId = useRef<string>(crypto.randomUUID());

  // Исполнители по выбранному клиенту: я первым и по умолчанию
  useEffect(() => {
    if (!open || !picked) return;
    let alive = true;
    void call<{ items: TaskAssignee[] }>('GET', `/api/tasks/assignees?clientId=${encodeURIComponent(picked.id)}`).then((r) => {
      if (!alive) return;
      if (!r.ok) return setError(r.key);
      setAssignees(r.data.items);
      setAssignee(r.data.items.find((a) => a.me)?.userId ?? r.data.items[0]?.userId ?? '');
    });
    return () => {
      alive = false;
    };
  }, [open, picked]);

  // Поиск своего клиента: от трёх символов, с паузой
  useEffect(() => {
    if (!open || picked) return;
    const q = query.trim();
    if (q.length < 3) return;
    let alive = true;
    const timer = setTimeout(() => {
      void call<{ items: Array<{ id: string; name: string }> }>('GET', `/api/clients?q=${encodeURIComponent(q)}&limit=10`).then((r) => {
        if (alive) setFound(r.ok ? r.data.items.map((c) => ({ id: c.id, name: c.name })) : []);
      });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, picked, query]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !picked) return;
    if (title.trim().length === 0) return setError('title');
    const dueAt = quickDue(quick, custom, timeZone);
    if (quick === 'custom' && dueAt === null) return setError('invalid');
    setBusy(true);
    setError(null);
    const r = await call<{ task: TaskRow; warnings: string[] }>('POST', '/api/tasks', {
      opId: opId.current,
      clientId: picked.id,
      kind,
      title: title.trim(),
      dueAt,
      assigneeUserId: assignee,
    });
    setBusy(false);
    if (!r.ok) {
      if (r.key !== 'network') opId.current = crypto.randomUUID();
      return setError(r.key);
    }
    toast.show({ message: t('toast.created'), tone: 'success' });
    if (r.data.warnings.includes('due_outside_work_hours')) toast.show({ message: t('warn.dueOutsideWork'), tone: 'info' });
    onCreated(r.data.task);
    onClose();
  }

  // Найденное показываем только для запроса от трёх символов (старый ответ не мигает при стирании)
  const shown = query.trim().length >= 3 ? found : null;

  const footer = (
    <Button block type="submit" form="new-task-form" disabled={busy || !picked || !assignee}>
      {busy ? t('form.saving') : t('form.submit')}
    </Button>
  );

  return (
    <BottomSheet open={open} onClose={onClose} title={t('form.newTitle')} closeLabel={t('actions.close')} footer={footer}>
      <form id="new-task-form" onSubmit={submit} className="flex flex-col gap-3" noValidate>
        {error && <Alert tone="danger">{t(`errors.${error}`)}</Alert>}
        {picked ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-[var(--text-2)]">{t('form.client')}:</span>
            <strong data-testid="new-task-client">{picked.name ?? t('row.clientHidden')}</strong>
            {!client && (
              <Button size="sm" variant="quiet" onClick={() => setPicked(null)}>
                {t('form.clientChange')}
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <Field label={t('form.clientSearch')} hint={t('form.clientSearchHint')}>
              <Input name="taskClientQuery" type="search" value={query} maxLength={200} onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
            </Field>
            {shown !== null && shown.length === 0 && <p className="text-[var(--text-2)]">{t('form.clientNone')}</p>}
            {shown && shown.length > 0 && (
              <ul className="flex flex-col gap-1">
                {shown.map((c) => (
                  <li key={c.id}>
                    <Button size="sm" variant="secondary" block aria-label={t('form.clientPick', { name: c.name ?? '' })} onClick={() => setPicked(c)}>
                      {c.name}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <Field label={t('form.kind')}>
          <Select name="taskKind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`kind.${k}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('form.title')}>
          <Input name="taskTitle" value={title} maxLength={200} placeholder={t('form.titlePlaceholder')} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">{t('form.due')}</legend>
          <ChipGroup label={t('form.due')} className="flex-wrap">
            {(['today', 'tomorrow', 'custom', 'none'] as const).map((q) => (
              <Chip key={q} active={quick === q} onClick={() => setQuick(q)}>
                {t(`form.quick.${q}`)}
              </Chip>
            ))}
          </ChipGroup>
          {quick === 'custom' && (
            <Field label={t('form.dueCustom')}>
              <Input name="taskDue" type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
            </Field>
          )}
        </fieldset>
        {assignees.length > 1 ? (
          <Field label={t('form.assignee')}>
            <Select name="taskAssignee" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              {assignees.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.me ? t('form.me', { name: a.name }) : a.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
      </form>
    </BottomSheet>
  );
}
