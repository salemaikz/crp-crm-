'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Field, Page, PageHeader, Select, useToast } from '@/ui/kit';
import { call } from '../api';
import type { TransferPreview, TransferResult, TransferStaffItem } from '../types';

type Props = { staff: TransferStaffItem[]; initialFrom: string };

/**
 * «Передача клиентов» (B9a): от кого, что (рабочие / все), кому (одному / поровну), предпросмотр счётчиками и одна
 * главная кнопка «Передать N карточек». Повтор нажатия безопасен: `opId` живёт, пока операция не завершилась.
 */
export function TransferScreen({ staff, initialFrom }: Props) {
  const t = useTranslations('team');
  const te = useTranslations('team.transfer.errors');
  const tc = useTranslations('clients.states');
  const toast = useToast();
  const [from, setFrom] = useState(initialFrom);
  const [scope, setScope] = useState<'working' | 'all'>('working');
  const [toMode, setToMode] = useState<'one' | 'even'>('one');
  const [toOne, setToOne] = useState('');
  const [toEven, setToEven] = useState<string[]>([]);
  // Предпросмотр привязан к выбору (сотрудник, охват, счётчик перечитываний): устаревший ответ не показывается
  const [loaded, setLoaded] = useState<{ key: string; preview: TransferPreview | null; error: string | null } | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const opId = useRef(crypto.randomUUID());
  const key = `${from}|${scope}|${tick}`;

  useEffect(() => {
    if (!from) return;
    let alive = true;
    void call<TransferPreview>('GET', `/api/team/transfers/preview?from=${encodeURIComponent(from)}&scope=${scope}`, undefined, '/team/transfer').then((r) => {
      if (alive) setLoaded({ key, preview: r.ok ? r.data : null, error: r.ok ? null : r.key });
    });
    return () => {
      alive = false;
    };
  }, [from, scope, key]);

  const current = loaded?.key === key ? loaded : null;
  const preview = current?.preview ?? null;
  const loading = from !== '' && current === null;
  const error = actionError ?? current?.error ?? null;

  const recipients = staff.filter((s) => s.active && s.userId !== from);
  const picked = toMode === 'one' ? (toOne ? [toOne] : []) : toEven;
  const ready = preview !== null && preview.total > 0 && !preview.tooMany && (toMode === 'one' ? picked.length === 1 : picked.length >= 2) && !busy;

  async function submit() {
    if (!ready || !preview) return;
    setBusy(true);
    setActionError(null);
    const to = toMode === 'one' ? { userId: toOne } : { even: toEven };
    const r = await call<TransferResult>('POST', '/api/team/transfers/bulk', { opId: opId.current, fromUserId: from, scope, to }, '/team/transfer');
    setBusy(false);
    if (!r.ok) {
      setActionError(r.key);
      // отказ сервера — новая операция; сеть — тот же opId, повтор безопасен
      if (r.key !== 'network') opId.current = crypto.randomUUID();
      return;
    }
    opId.current = crypto.randomUUID();
    toast.show({ message: t('transfer.done', { moved: r.data.moved }), tone: 'success' });
    setTick((n) => n + 1); // предпросмотр перечитываем: карточек у сотрудника стало меньше
  }

  return (
    <Page width="form">
      <PageHeader title={t('transfer.title')} lead={t('transfer.lead')} />
      <div className="flex max-w-xl flex-col gap-4">
        <Field label={t('transfer.from')}>
          <Select name="transfer-from" value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">{t('transfer.choose')}</option>
            {staff.map((s) => (
              <option key={s.userId} value={s.userId}>
                {s.active ? s.name : t('transfer.fromDisabled', { name: s.name })}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('transfer.scope.label')}>
          <Select name="transfer-scope" value={scope} onChange={(e) => setScope(e.target.value as 'working' | 'all')}>
            <option value="working">{t('transfer.scope.working')}</option>
            <option value="all">{t('transfer.scope.all')}</option>
          </Select>
        </Field>
        <Field label={t('transfer.to.label')}>
          <Select name="transfer-to-mode" value={toMode} onChange={(e) => setToMode(e.target.value as 'one' | 'even')}>
            <option value="one">{t('transfer.to.one')}</option>
            <option value="even">{t('transfer.to.even')}</option>
          </Select>
        </Field>
        {toMode === 'one' ? (
          <Field label={t('transfer.to.recipient')}>
            <Select name="transfer-to" value={toOne} onChange={(e) => setToOne(e.target.value)}>
              <option value="">{t('transfer.choose')}</option>
              {recipients.map((s) => (
                <option key={s.userId} value={s.userId}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-sm text-[var(--text-2)]">{t('transfer.to.recipients')}</legend>
            {recipients.map((s) => (
              <Checkbox
                key={s.userId}
                label={s.name}
                checked={toEven.includes(s.userId)}
                onChange={(e) => setToEven((cur) => (e.target.checked ? [...cur, s.userId] : cur.filter((x) => x !== s.userId)))}
              />
            ))}
          </fieldset>
        )}
        {from && (
          <section aria-label={t('transfer.preview.title')} aria-live="polite" className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">{t('transfer.preview.title')}</h2>
            {loading && <p>{t('transfer.preview.loading')}</p>}
            {preview && preview.total === 0 && <p>{t('transfer.preview.empty')}</p>}
            {preview && preview.total > 0 && (
              <ul className="text-sm">
                <li>{t('transfer.preview.cards', { total: preview.total })}</li>
                {Object.entries(preview.cards).map(([state, n]) => (
                  <li key={state}>
                    {tc(state as 'new')}: {n}
                  </li>
                ))}
                <li>{t('transfer.preview.families', { families: preview.families })}</li>
                <li>{t('transfer.preview.tasks', { tasks: preview.tasks })}</li>
                <li>{t('transfer.preview.deals', { deals: preview.deals })}</li>
                <li>{t('transfer.preview.bookings', { bookings: preview.bookings })}</li>
              </ul>
            )}
          </section>
        )}
        {error && <Alert tone="danger">{te(error as 'generic')}</Alert>}
        <div>
          <Button disabled={!ready} onClick={() => void submit()}>
            {busy ? t('transfer.submitting') : t('transfer.submit', { count: preview?.total ?? 0 })}
          </Button>
        </div>
      </div>
    </Page>
  );
}
