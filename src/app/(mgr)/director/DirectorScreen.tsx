'use client';

import { RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { fmtDec, fmtInt, formatDay } from '../reports/format';
import { FUNNEL_STEPS } from '../reports/types';
import { Alert, Button, EmptyState, Page, PageHeader, Section, Stat, StatGrid, Table, type TableColumn } from '@/ui/kit';
import type { DirectorData, DirectorProps, RevenueRow } from './types';

type Failure = 'forbidden' | 'unauthorized' | 'network' | 'generic';

async function load(): Promise<{ ok: true; data: DirectorData } | { ok: false; key: Failure }> {
  try {
    const res = await fetch('/api/reports/director', { cache: 'no-store' });
    if (res.status === 401) {
      window.location.replace('/login?next=/director');
      return { ok: false, key: 'unauthorized' };
    }
    if (res.status === 403) return { ok: false, key: 'forbidden' };
    if (!res.ok) return { ok: false, key: 'generic' };
    return { ok: true, data: (await res.json()) as DirectorData };
  } catch {
    return { ok: false, key: 'network' };
  }
}

/** Адрес подробного отчёта с той же неделей. */
function moreHref(report: string, d: DirectorData): string {
  return `/reports?r=${report}&from=${d.week.from}&to=${d.week.to}`;
}

export function DirectorScreen({ initial, labels, canExport }: DirectorProps) {
  const t = useTranslations('reports.director');
  const tp = useTranslations('reports.page');
  const tf = useTranslations('reports.funnel');
  const tr = useTranslations('reports.revenue');
  const [data, setData] = useState<DirectorData>(initial);
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

  const money = (v: number) => tp('money', { value: fmtInt(v) });
  const percent = (v: number | null) => (v === null ? tp('none') : tp('percent', { value: fmtDec(v) }));
  const prev = (value: string) => t('prevWeek', { value });
  const att = data.attendance;
  const revenueRows: RevenueRow[] = data.revenue;
  const cols: TableColumn<RevenueRow>[] = [
    {
      key: 'type',
      header: tr('cols.type'),
      primary: true,
      cell: (r) => <strong>{r.serviceTypeKey === '' ? tr('noType') : (labels.serviceTypes[r.serviceTypeKey] ?? r.serviceTypeKey)}</strong>,
    },
    { key: 'purchases', header: tr('cols.purchases'), numeric: true, cell: (r) => fmtInt(r.purchases) },
    { key: 'sum', header: tr('cols.sum'), numeric: true, cell: (r) => money(r.sumKzt) },
  ];
  const stock = data.stock;
  const updated = new Intl.DateTimeFormat('ru-RU', { timeZone: data.week.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(data.generatedAt));

  return (
    <Page width="wide">
      <PageHeader
        title={t('title')}
        lead={`${t('lead', { from: formatDay(data.week.from), to: formatDay(data.week.to) })} · ${t('updatedAt', { time: updated })}`}
        actions={
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={busy} aria-busy={busy}>
            <RefreshCw aria-hidden="true" size={18} /> {t('refresh')}
          </Button>
        }
      />
      {error && <Alert tone="warning">{t(`errors.${error}`)}</Alert>}
      <StatGrid aria-label={t('tilesLabel')}>
        <Stat
          value={t('tiles.calls.value', { outcomes: fmtInt(data.calls.outcomes), connects: fmtInt(data.calls.connects) })}
          label={t('tiles.calls.title')}
          hint={
            <>
              {t('tiles.calls.hint')}
              <br />
              {prev(fmtInt(data.calls.prevOutcomes))}
            </>
          }
        />
        <Stat
          value={t('tiles.bookings.value', { groups: fmtInt(data.bookings.groups), consults: fmtInt(data.bookings.consults) })}
          label={t('tiles.bookings.title')}
          hint={t('tiles.bookings.hint')}
        />
        <Stat
          value={t('tiles.attendance.value', { attended: fmtInt(att.attended), total: fmtInt(att.attended + att.noShow) })}
          label={`${t('tiles.attendance.title')}: ${percent(att.rate)}`}
          hint={t('tiles.attendance.hint', { noShow: fmtInt(att.noShow) })}
        />
        <Stat
          value={t('tiles.purchases.value', { count: fmtInt(data.purchases.count) })}
          label={t('tiles.purchases.title')}
          hint={
            <>
              {t('tiles.purchases.hint', { sum: money(data.purchases.sumKzt) })}
              <br />
              {prev(`${fmtInt(data.purchases.prevCount)} · ${money(data.purchases.prevSumKzt)}`)}
            </>
          }
        />
        <Stat
          value={stock.days === null ? t('tiles.stock.none') : t('tiles.stock.value', { days: fmtDec(stock.days) })}
          label={t('tiles.stock.title')}
          hint={t('tiles.stock.hint', { ready: fmtInt(stock.poolReady), capacity: fmtInt(stock.capacityPerDay) })}
        />
      </StatGrid>

      {/* Каждая «подробнее» стоит в шапке своего блока, а не рядом внизу страницы */}
      <Section
        title={t('funnel.title')}
        actions={
          <>
            <Button variant="quiet" size="sm" href={moreHref('funnel', data)}>
              {t('more')}
            </Button>
            <Button variant="quiet" size="sm" href={moreHref('operators', data)}>
              {t('moreOperators')}
            </Button>
            <Button variant="quiet" size="sm" href={moreHref('attendance', data)}>
              {t('moreAttendance')}
            </Button>
          </>
        }
      >
        <StatGrid variant="strip" aria-label={t('funnel.title')}>
          {FUNNEL_STEPS.map((step) => (
            <Stat key={step} value={fmtInt(data.funnel.counts[step])} label={tf(`steps.${step}`)} hint={step === 'issued' ? undefined : percent(data.funnel.rates[step])} />
          ))}
        </StatGrid>
      </Section>

      <Section
        title={t('revenue.title')}
        actions={
          <>
            <Button variant="quiet" size="sm" href={moreHref('revenue', data)}>
              {t('more')}
            </Button>
            {canExport && (
              <Button variant="secondary" size="sm" href={`/api/reports/revenue/export?from=${data.week.from}&to=${data.week.to}&format=csv`} external download>
                {t('export.revenue')}
              </Button>
            )}
          </>
        }
      >
        {revenueRows.length === 0 ? (
          <EmptyState title={t('revenue.empty')} />
        ) : (
          <div className="min-w-0">
            <Table caption={tr('caption')} captionHidden columns={cols} rows={revenueRows} rowKey={(r) => r.serviceTypeKey} dense stackOnMobile={false} />
          </div>
        )}
      </Section>
    </Page>
  );
}
