'use client';

import { RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, EmptyState, Page, PageHeader, Section, Stat, StatGrid } from '@/ui/kit';
import Link from 'next/link';
import { formatTime } from './format';
import { bookingsHref, confirmHref, overdueHref } from './links';
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
  const overdueLink = data.board.on ? overdueHref(data.board.callbackTab) : null;
  const bookingsLink = bookingsHref(data.board.on);
  const confirmLink = confirmHref(data.board);
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
        <Stat value={tl.grey.waiting} label={data.eventLabels.individual === '' ? t('tiles.grey.titleFallback') : t('tiles.grey.title', { event: data.eventLabels.individual })} hint={t('tiles.grey.hint')} />
        <Stat
          value={tl.bookings.today.total}
          label={bookingsLink ? <TileLink href={bookingsLink} testId="summary-link-bookings">{t('tiles.bookings.title')}</TileLink> : t('tiles.bookings.title')}
          hint={
            <>
              {t('tiles.bookings.today', tl.bookings.today)}
              <br />
              {t('tiles.bookings.tomorrow', tl.bookings.tomorrow)}
              {confirmLink && (
                <>
                  <br />
                  <TileLink href={confirmLink} testId="summary-link-confirm">{t('tiles.bookings.confirm')}</TileLink>
                </>
              )}
            </>
          }
        />
        <Stat
          value={tl.overdue.cards}
          label={overdueLink && tl.overdue.cards > 0 ? <TileLink href={overdueLink} testId="summary-link-overdue">{t('tiles.overdue.title')}</TileLink> : t('tiles.overdue.title')}
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

/** Название плитки как ссылка: число остаётся крупным, переход — по подписи. */
function TileLink({ href, testId, children }: { href: string; testId: string; children: ReactNode }) {
  return (
    <Link href={href} className="underline underline-offset-2" data-testid={testId}>
      {children}
    </Link>
  );
}
