'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, TextLink, useToast } from '@/ui/kit';
import { formatDateTime } from '../../distribution/format';
import { call } from './api';
import { MergeDialog } from './MergeDialog';
import { SplitDialog } from './SplitDialog';
import type { PairRow, PairSide, PairsData } from './types';

/**
 * «Спорные пары» (B9b): две стороны рядом (на телефоне — друг под другом), причина пары и решения РОП:
 * «Разные — тому же оператору», «Выдать другому…» (комментарий), «Объединить…» (за флагом, предпросмотр).
 */
export function PairsScreen({ data }: { data: PairsData }) {
  const t = useTranslations('pairs');
  const te = useTranslations('pairs.errors');
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [split, setSplit] = useState<PairRow | null>(null);
  const [merge, setMerge] = useState<PairRow | null>(null);
  // Следующие страницы по курсору; после решения список перечитывается с первой страницы
  const [more, setMore] = useState<{ items: PairRow[]; next: string | null } | null>(null);
  const items = more ? [...data.items, ...more.items.filter((p) => !data.items.some((d) => d.id === p.id))] : data.items;
  const next = more ? more.next : data.next;

  async function loadMore() {
    if (!next || busy) return;
    setBusy('more');
    setError(null);
    const r = await call<{ items: PairRow[]; next: string | null }>('GET', `/api/distribution/pairs?cursor=${encodeURIComponent(next)}`);
    setBusy(null);
    if (!r.ok) return setError(r.key);
    setMore({ items: [...(more?.items ?? []), ...r.data.items], next: r.data.next });
  }

  async function distinct(pair: PairRow) {
    if (busy) return;
    setBusy(pair.id);
    setError(null);
    const r = await call<{ status: string }>('POST', `/api/distribution/pairs/${encodeURIComponent(pair.id)}/resolve`, { decision: 'distinct', comment: '' });
    setBusy(null);
    if (!r.ok) return setError(r.key);
    toast.show({ message: t('done.distinct'), tone: 'success' });
    setMore(null);
    router.refresh();
  }

  const done = (key: 'split_allowed' | 'merged') => {
    setSplit(null);
    setMerge(null);
    toast.show({ message: t(`done.${key}`), tone: 'success' });
    setMore(null);
    router.refresh();
  };

  return (
    <>
      <PageHeader title={t('title')} lead={t('lead')} />
      {error && <Alert tone="danger">{te(error as 'generic')}</Alert>}
      {items.length === 0 ? (
        <EmptyState title={t('empty.title')} description={t('empty.description')} />
      ) : (
        <ul className="flex min-w-0 flex-col gap-4">
          {items.map((pair) => (
            <li key={pair.id} className="min-w-0">
              <Card as="article" aria-label={t(`reason.${pair.reason}`)} className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warning">{t(`reason.${pair.reason}`)}</Badge>
                  <span className="text-sm text-[var(--text-2)]">{formatDateTime(pair.createdAt, data.timeZone)}</span>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
                  <Side label={t('side.a')} side={pair.a} timeZone={data.timeZone} />
                  <Side label={t('side.b')} side={pair.b} timeZone={data.timeZone} />
                </div>
                {pair.status === 'open' && data.canResolve && (
                  <div className="flex flex-wrap gap-2">
                    <Button variant="secondary" disabled={busy !== null} onClick={() => void distinct(pair)}>
                      {t('actions.distinct')}
                    </Button>
                    <Button variant="quiet" disabled={busy !== null} onClick={() => setSplit(pair)}>
                      {t('actions.split')}
                    </Button>
                    {data.canMerge && pair.a && pair.b && (
                      <Button variant="secondary" disabled={busy !== null} onClick={() => setMerge(pair)}>
                        {t('actions.merge')}
                      </Button>
                    )}
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {next && (
        <div>
          <Button variant="secondary" disabled={busy !== null} onClick={() => void loadMore()}>
            {t('more')}
          </Button>
        </div>
      )}
      {split && <SplitDialog pair={split} onClose={() => setSplit(null)} onDone={() => done('split_allowed')} />}
      {merge && <MergeDialog pair={merge} onClose={() => setMerge(null)} onDone={() => done('merged')} />}
    </>
  );
}

function Side({ label, side, timeZone }: { label: string; side: PairSide | null; timeZone: string }) {
  const t = useTranslations('pairs.side');
  const tc = useTranslations('clients.states');
  if (!side) {
    return (
      <section aria-label={label} className="min-w-0 rounded-md border border-dashed border-[var(--border)] p-3">
        <h3 className="text-sm font-semibold">{label}</h3>
        <p className="text-sm text-[var(--text-2)]">{t('hidden')}</p>
      </section>
    );
  }
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-1 rounded-md border border-[var(--border)] p-3">
      <h3 className="text-sm text-[var(--text-2)]">{label}</h3>
      <TextLink href={`/clients/${encodeURIComponent(side.clientId)}`} className="break-words font-semibold">
        {side.name}
      </TextLink>
      {side.orgId && <span className="text-sm">{t('orgId', { orgId: side.orgId })}</span>}
      <span className="flex flex-wrap gap-2">
        <Badge tone="neutral">{tc(side.state as 'new')}</Badge>
      </span>
      <span className="text-sm">{side.ownerName ? t('owner', { name: side.ownerName }) : t('noOwner')}</span>
      <span className="text-sm text-[var(--text-2)]">{side.lastTouchAt ? t('lastTouch', { at: formatDateTime(side.lastTouchAt, timeZone) }) : t('noTouch')}</span>
      <h4 className="mt-1 text-sm font-semibold">{t('phones')}</h4>
      {side.phones.length === 0 ? (
        <span className="text-sm">{t('noPhones')}</span>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {side.phones.map((p, i) => (
            <li key={p.phone ?? `stop-${i}`} className="flex flex-wrap items-center gap-2">
              {p.phone && <span className="tabular-nums">{p.phone}</span>}
              {p.shared && <Badge tone="warning">{t('shared')}</Badge>}
              {!p.working && <Badge tone="neutral">{t('notWorking')}</Badge>}
              {p.stopListed && <Badge tone="danger">{t('stopListed')}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
