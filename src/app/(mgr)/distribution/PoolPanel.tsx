'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Checkbox, EmptyState, Modal, Select, Stat, Table, TextLink, type TableColumn } from '@/ui/kit';
import { call } from './api';
import { formatDateTime } from './format';
import type { DistributionData, IssueResultData, PoolHoldKind, PoolItemRow, PoolPageData } from './types';

const HOLD_KINDS: readonly PoolHoldKind[] = ['hold:dup_pair', 'hold:import_conflict', 'hold:no_working_phone', 'hold:rule', 'pair_blocked'];

export function PoolPanel({ data, onChanged }: { data: DistributionData; onChanged: () => void }) {
  const t = useTranslations('distribution');
  const te = useTranslations('distribution.errors');
  const [items, setItems] = useState<PoolItemRow[]>(data.pool.items);
  const [next, setNext] = useState<string | null>(data.pool.next);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [toUserId, setToUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ key: string; remaining?: number; cap?: number } | null>(null);
  const [result, setResult] = useState<IssueResultData | null>(null);
  const summary = data.pool.summary;
  const operators = data.participants.filter((p) => p.status === 'working');

  const toggle = (item: PoolItemRow, on: boolean) => {
    const copy = new Set(selected);
    // Пара выдаётся вместе: отмечаем и снимаем всю группу.
    for (const id of [item.cardId, ...item.twinCardIds]) {
      if (on) copy.add(id);
      else copy.delete(id);
    }
    setSelected(copy);
  };

  async function more() {
    if (!next || busy) return;
    setBusy(true);
    const r = await call<PoolPageData>('GET', `/api/distribution/pool?limit=50&cursor=${encodeURIComponent(next)}`);
    setBusy(false);
    if (!r.ok) return setError({ key: r.key });
    setItems((cur) => [...cur, ...r.data.items.filter((i) => !cur.some((c) => c.cardId === i.cardId))]);
    setNext(r.data.next);
  }

  async function issue() {
    if (busy || !toUserId || selected.size === 0) return;
    setBusy(true);
    setError(null);
    const r = await call<IssueResultData>('POST', '/api/distribution/issue', { opId: crypto.randomUUID(), toUserId, cardIds: [...selected].slice(0, 100) });
    setBusy(false);
    if (!r.ok) return setError({ key: r.key, ...(r.remaining !== undefined ? { remaining: r.remaining, cap: r.cap } : {}) });
    setResult(r.data);
    setSelected(new Set());
    onChanged();
  }

  const close = () => {
    setOpen(false);
    setResult(null);
    setError(null);
  };

  const columns: TableColumn<PoolItemRow>[] = [
    {
      key: 'select',
      header: t('pool.columns.select'),
      cell: (i) => (
        <Checkbox
          label=""
          aria-label={t('pool.selectRow', { name: i.name })}
          checked={selected.has(i.cardId)}
          disabled={!data.canIssue}
          onChange={(e) => toggle(i, e.target.checked)}
        />
      ),
    },
    { key: 'name', header: t('pool.columns.name'), primary: true, cell: (i) => <strong>{i.name}</strong> },
    { key: 'created', header: t('pool.columns.created'), cell: (i) => formatDateTime(i.createdAt, data.timeZone) },
    { key: 'phone', header: t('pool.columns.phone'), cell: (i) => <Badge tone="neutral">{i.hasMobile ? t('pool.mobile') : t('pool.landline')}</Badge> },
    {
      key: 'note',
      header: t('pool.columns.note'),
      cell: (i) => (
        <span className="flex flex-wrap gap-2">
          {i.twinCardIds.length > 0 && <Badge tone="info">{t('pool.twins', { count: i.twinCardIds.length })}</Badge>}
          {i.heldByUserId && <Badge tone="warning">{t('pool.heldBy')}</Badge>}
        </span>
      ),
    },
  ];

  return (
    <>
      <div className="flex flex-wrap gap-4">
        <Stat value={summary.ready} label={t('pool.summary.ready')} />
        <Stat value={summary.roomToday} label={t('pool.summary.room')} />
        <Stat value={summary.overCap} label={t('pool.summary.overCap')} tone={summary.overCap > 0 ? 'danger' : 'default'} />
      </div>
      <ul aria-label={t('pool.held.title')} className="flex flex-wrap gap-2">
        {HOLD_KINDS.filter((k) => summary.held[k] > 0).map((k) => (
          <li key={k}>
            <Badge tone="warning">
              {t(`pool.held.${k}`)}: {summary.held[k]}
            </Badge>
          </li>
        ))}
      </ul>
      <TextLink href="/pairs">{t('pool.pairsLink')}</TextLink>
      {data.canIssue && (
        <div className="flex flex-wrap items-center gap-3">
          <span aria-live="polite">{t('pool.selected', { count: selected.size })}</span>
          <Button disabled={selected.size === 0} onClick={() => setOpen(true)}>
            {t('pool.issue')}
          </Button>
        </div>
      )}
      <Table
        columns={columns}
        rows={items}
        rowKey={(i) => i.cardId}
        empty={<EmptyState framed={false} title={t('pool.empty.title')} description={t('pool.empty.description')} />}
      />
      {next && (
        <Button variant="secondary" disabled={busy} onClick={() => void more()}>
          {t('pool.more')}
        </Button>
      )}
      <Modal open={open} onClose={close} title={t('issue.title')} closeLabel={t('issue.cancel')}>
        {result ? (
          <div className="flex flex-col gap-3">
            <Alert tone="success">{t('issue.done', { count: result.issued.length })}</Alert>
            {result.skipped.length > 0 && (
              <Alert tone="warning" title={t('issue.skipped', { count: result.skipped.length })}>
                <ul>
                  {[...new Set(result.skipped.map((s) => s.reason))].map((reason) => (
                    <li key={reason}>{t(`issue.skip.${reason}`)}</li>
                  ))}
                </ul>
              </Alert>
            )}
            <Button onClick={close}>{t('issue.cancel')}</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {error && <Alert tone="danger">{te(error.key, { remaining: error.remaining ?? 0, cap: error.cap ?? 0 })}</Alert>}
            <label className="flex flex-col gap-1">
              <span>{t('issue.to')}</span>
              <Select value={toUserId} onChange={(e) => setToUserId(e.target.value)}>
                <option value="">{t('issue.pick')}</option>
                {data.participants.map((p) => (
                  <option key={p.userId} value={p.userId} disabled={p.status !== 'working'}>
                    {p.name} — {p.status === 'working' ? t('issue.remaining', { remaining: p.remaining, cap: p.cap }) : t('issue.notWorking')}
                  </option>
                ))}
              </Select>
            </label>
            <div className="flex gap-2">
              <Button disabled={busy || !toUserId || operators.length === 0} onClick={() => void issue()}>
                {t('issue.confirm')}
              </Button>
              <Button variant="secondary" onClick={close}>
                {t('issue.cancel')}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
