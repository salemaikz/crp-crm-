'use client';

import { RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, EmptyState, Page, PageHeader, Section, Stat, StatGrid } from '@/ui/kit';
import { formatTime } from './format';
import { OperatorsTable } from './OperatorsTable';
import type { SummaryData } from './types';

/** Обновление по таймеру — раз в минуту, пока вкладка видна. */
export const REFRESH_MS = 60_000;

type Failure = 'forbidden' | 'unauthorized' | 'network' | 'generic';

async function load(): Promise<{ ok: true; data: SummaryData } | { ok: false; key: Failure }> {
  try {
    const res = await fetch('/api/reports/summary', { cache: 'no-store' });
    if (res.status === 401) {
      window.location.replace('/login?next=/summary');
      return { ok: false, key: 'unauthorized' };
    }
    if (res.status === 403) return { ok: false, key: 'forbidden' };
    if (!res.ok) return { ok: false, key: 'generic' };
    return { ok: true, data: (await res.json()) as SummaryData };
  } catch {
    return { ok: false, key: 'network' };
  }
}

export function SummaryScreen({ initial }: { initial: SummaryData }) {
  const t = useTranslations('reports.summary');
  const [data, setData] = useState<SummaryData>(initial);
  const [error, setError] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    const r = await load();
    inflight.current = false;
    setBusy(false);
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else setError(r.key);
  }, []);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const timer = window.setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [refresh]);

  const tl = data.tiles;
  const time = formatTime(data.generatedAt, data.timeZone);
  return (
    <Page width="wide">
      <PageHeader
        title={t('title')}
        lead={`${t('lead')} · ${t('updatedAt', { time })}`}
        actions={
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={busy} aria-busy={busy}>
            <RefreshCw aria-hidden="true" size={18} /> {t('refresh')}
          </Button>
        }
      />
      {error && <Alert tone="warning">{t(`errors.${error}`, { time })}</Alert>}
      <StatGrid aria-label={t('tiles.label')}>
        <Stat value={tl.pool.ready} label={`${t('tiles.pool.title')}: ${t('tiles.pool.ready')}`} hint={t('tiles.pool.hint', { overCap: tl.pool.overCap, duplicates: tl.pool.duplicates, disputed: tl.pool.disputed })} />
        <Stat
          value={t('tiles.issued.value', { issued: tl.issued.issued, cap: tl.issued.cap })}
          label={t('tiles.issued.title')}
          hint={t('tiles.issued.hint', { operators: tl.issued.operators })}
        />
        <Stat value={tl.grey.waiting} label={t('tiles.grey.title')} hint={t('tiles.grey.hint')} />
        <Stat
          value={tl.bookings.today.total}
          label={t('tiles.bookings.title')}
          hint={
            <>
              {t('tiles.bookings.today', tl.bookings.today)}
              <br />
              {t('tiles.bookings.tomorrow', tl.bookings.tomorrow)}
            </>
          }
        />
        <Stat
          value={tl.overdue.cards}
          label={t('tiles.overdue.title')}
          tone={data.alarm ? 'danger' : 'default'}
          hint={tl.overdue.cards > 0 ? t('tiles.overdue.hint', { operators: tl.overdue.operators }) : t('tiles.overdue.none')}
        />
        <Stat
          value={tl.unsent.pending}
          label={t('tiles.unsent.title')}
          hint={tl.unsent.pending > 0 ? t('tiles.unsent.hint', { operators: tl.unsent.operators }) : t('tiles.unsent.none')}
        />
      </StatGrid>
      <Section title={t('operators.title')}>
        {data.operators.length === 0 ? (
          <EmptyState title={t('operators.empty.title')} description={t('operators.empty.description')} />
        ) : (
          <OperatorsTable data={data} />
        )}
      </Section>
    </Page>
  );
}
