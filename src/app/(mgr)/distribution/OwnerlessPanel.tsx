'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Checkbox, EmptyState, Modal, Select, Table, useToast, type TableColumn } from '@/ui/kit';
import { call } from './api';
import { formatDateTime } from './format';
import type { DistributionData, OwnerlessAssignData, OwnerlessItemRow, OwnerlessPageData } from './types';

/** Раздел «Без владельца (не новые)»: страховочный, в норме пуст. Выбрать строки и назначить работающему сотруднику. */
export function OwnerlessPanel({ data, onChanged }: { data: DistributionData; onChanged: () => void }) {
  const t = useTranslations('distribution');
  const te = useTranslations('distribution.errors');
  const toast = useToast();
  const [items, setItems] = useState<OwnerlessItemRow[]>(data.ownerless.items);
  const [next, setNext] = useState<string | null>(data.ownerless.next);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [toUserId, setToUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string, on: boolean) => {
    const copy = new Set(selected);
    if (on) copy.add(id);
    else copy.delete(id);
    setSelected(copy);
  };

  async function more() {
    if (!next || busy) return;
    setBusy(true);
    const r = await call<OwnerlessPageData>('GET', `/api/distribution/ownerless?limit=50&cursor=${encodeURIComponent(next)}`);
    setBusy(false);
    if (!r.ok) return setError(r.key);
    setItems((cur) => [...cur, ...r.data.items.filter((i) => !cur.some((c) => c.cardId === i.cardId))]);
    setNext(r.data.next);
  }

  async function assign() {
    if (busy || !toUserId || selected.size === 0) return;
    setBusy(true);
    setError(null);
    const chosen = items.filter((i) => selected.has(i.cardId)).slice(0, 100);
    const r = await call<OwnerlessAssignData>('POST', '/api/distribution/ownerless/assign', {
      opId: crypto.randomUUID(),
      toUserId,
      items: chosen.map((i) => ({ cardId: i.cardId, version: i.version })),
    });
    setBusy(false);
    if (!r.ok) return setError(r.key);
    toast.show({ message: t('ownerless.done', { count: r.data.assigned, skipped: r.data.skipped.length }), tone: r.data.skipped.length > 0 ? 'info' : 'success' });
    setSelected(new Set());
    setOpen(false);
    onChanged();
  }

  const columns: TableColumn<OwnerlessItemRow>[] = [
    {
      key: 'select',
      header: t('pool.columns.select'),
      cell: (i) => (
        <Checkbox label="" aria-label={t('pool.selectRow', { name: i.name })} checked={selected.has(i.cardId)} disabled={!data.canIssue} onChange={(e) => toggle(i.cardId, e.target.checked)} />
      ),
    },
    { key: 'name', header: t('pool.columns.name'), primary: true, cell: (i) => <strong>{i.name}</strong> },
    { key: 'state', header: t('ownerless.columns.state'), cell: (i) => <Badge tone="warning">{t(`ownerless.state.${i.state}`)}</Badge> },
    { key: 'next', header: t('ownerless.columns.nextCall'), cell: (i) => (i.nextCallAt === null ? '—' : formatDateTime(i.nextCallAt, data.timeZone)) },
  ];

  const operators = data.participants.filter((p) => p.status === 'working');

  return (
    <>
      <p>{t('ownerless.lead')}</p>
      {error && <Alert tone="danger">{te(error)}</Alert>}
      {data.canIssue && items.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <span aria-live="polite">{t('pool.selected', { count: selected.size })}</span>
          <Button disabled={selected.size === 0} onClick={() => setOpen(true)}>
            {t('ownerless.assign')}
          </Button>
        </div>
      )}
      <Table
        columns={columns}
        rows={items}
        rowKey={(i) => i.cardId}
        empty={<EmptyState framed={false} title={t('ownerless.empty.title')} description={t('ownerless.empty.description')} />}
      />
      {next && (
        <Button variant="secondary" disabled={busy} onClick={() => void more()}>
          {t('pool.more')}
        </Button>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={t('ownerless.assign')} closeLabel={t('issue.cancel')}>
        <div className="flex flex-col gap-3">
          {error && <Alert tone="danger">{te(error)}</Alert>}
          <label className="flex flex-col gap-1">
            <span>{t('issue.to')}</span>
            <Select value={toUserId} onChange={(e) => setToUserId(e.target.value)}>
              <option value="">{t('issue.pick')}</option>
              {operators.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.name}
                </option>
              ))}
            </Select>
          </label>
          <div className="flex gap-2">
            <Button disabled={busy || !toUserId} onClick={() => void assign()}>
              {t('ownerless.confirm')}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('issue.cancel')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
