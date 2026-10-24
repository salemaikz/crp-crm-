'use client';

import { RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState, type CSSProperties } from 'react';
import { fmtDec, fmtInt, formatDay } from '../reports/format';
import { FUNNEL_STEPS } from '../reports/types';
import { Alert, Button, EmptyState, Page, PageHeader, Segmented, Stat, StatGrid, Table, type TableColumn } from '@/ui/kit';
import { DirectorBlock } from './DirectorBlock';
import { useReasonLabel } from '../reports/reasonLabel';
import { delta, directorTiles, funnelHints, reasonLists, type FunnelHint } from './tiles';
import type { DirectorData, DirectorProps, DirectorReasons, RevenueRow } from './types';

type Failure = 'forbidden' | 'unauthorized' | 'network' | 'generic';

async function load(week: 'current' | 'prev'): Promise<{ ok: true; data: DirectorData } | { ok: false; key: Failure }> {
  try {
    const res = await fetch(`/api/reports/director${week === 'prev' ? '?week=prev' : ''}`, { cache: 'no-store' });
    if (res.status === 401) {
      window.location.replace(`/login?next=/director${week === 'prev' ? '%3Fweek%3Dprev' : ''}`);
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
  const tr0 = useTranslations('reports.reasons');
  const [data, setData] = useState<DirectorData>(initial);
  const [error, setError] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);

  const week = data.weekKey;
  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    const r = await load(week);
    inflight.current = false;
    setBusy(false);
    if (r.ok) {
      setData(r.data);
      setError(null);
    } else setError(r.key);
  }, [week]);

  const money = (v: number) => tp('money', { value: fmtInt(v) });
  const percent = (v: number | null) => (v === null ? tp('none') : tp('percent', { value: fmtDec(v) }));
  const isPrev = data.weekKey === 'prev';
  const prev = (value: string) => t(isPrev ? 'prevWeekShifted' : 'prevWeek', { value });
  const reasonLabel = useReasonLabel(labels);
  const att = data.attendance;
  const hints = funnelHints(data);
  const hintText = (h: FunnelHint): string =>
    h.kind === 'none' ? tp('none') : h.kind === 'attendance' ? t('funnel.attendanceRate', { rate: percent(h.value) }) : t('funnel.ofPrev', { pct: percent(h.value), prev: tf(`steps.${h.from}`) });
  const lists = reasonLists(data);
  const revenueRows: RevenueRow[] = data.revenue;
  const ReasonList = ({ role, block }: { role: 'trash' | 'callback'; block: DirectorReasons }) => (
    <div className="flex min-w-0 flex-col gap-2" data-testid={`director-reasons-${role}`}>
      <h3 className="m-0 flex flex-wrap items-baseline gap-x-3 text-base font-semibold">
        {block.label ?? tr0(`blockFallback.${role}`)}
        <span className="text-sm font-normal" style={{ color: 'var(--text-2)' }}>{tr0('block.total', { n: fmtInt(block.total) })}</span>
      </h3>
      {block.total === 0 ? (
        <p className="m-0 text-sm" style={{ color: 'var(--text-2)' }}>{t('reasons.empty')}</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-1 p-0">
          {block.top.map((r) => (
            <li key={`${r.group}|${r.reasonCode}`} className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">{reasonLabel(r)}</span>
              <span className="shrink-0 tabular-nums" style={{ color: 'var(--text-2)' }}>
                {fmtInt(r.count)} · {percent(r.share)}
              </span>
            </li>
          ))}
        </ol>
      )}
      {role === 'callback' && <p className="m-0 text-sm" style={{ color: 'var(--text-2)' }} data-testid="director-reasons-note">{t('reasons.callbackNote')}</p>}
    </div>
  );
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
  const updated = new Intl.DateTimeFormat('ru-RU', { timeZone: data.week.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(data.generatedAt));

  return (
    <Page width="wide">
      <PageHeader
        title={t('title')}
        lead={`${t(isPrev ? 'leadPrev' : 'lead', { from: formatDay(data.week.from), to: formatDay(data.week.to) })} · ${t('updatedAt', { time: updated })}`}
        tabs={
          <Segmented
            label={t('weekSwitch.label')}
            items={[
              { id: 'current', label: t('weekSwitch.current'), href: '/director', active: !isPrev, testId: 'week-current' },
              { id: 'prev', label: t('weekSwitch.prev'), href: '/director?week=prev', active: isPrev, testId: 'week-prev' },
            ]}
          />
        }
        actions={
          <Button variant="secondary" size="sm" onClick={() => void refresh()} disabled={busy} aria-busy={busy}>
            <RefreshCw aria-hidden="true" size={18} /> {t('refresh')}
          </Button>
        }
      />
      {error && <Alert tone="warning">{t(`errors.${error}`)}</Alert>}
      <DirectorBlock title={t('tilesLabel')} moreHref={moreHref('operators', data)} more={t('more')}>
      {/* Телефон: две колонки по 140 px, подписи не наезжают друг на друга (A2) */}
      <StatGrid aria-label={t('tilesLabel')} style={{ '--stat-min': '140px' } as CSSProperties}>
        {directorTiles(data)
          .filter((x) => x.label !== '')
          .map((x) => {
            const cmp = x.prev === undefined ? null : delta(x.value, x.prev);
            const extra =
              x.id === 'attendance'
                ? t('tiles.attendance.hint', { noShow: fmtInt(att.noShow), unmarked: fmtInt(att.unmarked) })
                : x.id === 'purchases'
                  ? t('tiles.purchases.hint', { sum: money(data.purchases.sumKzt) })
                  : x.id === 'conversion'
                    ? x.lowData
                      ? t('tiles.conversion.emptyHint', { min: data.conversion.minConnects })
                      : (
                          <>
                            {t('tiles.conversion.hintLead')}
                            <br />
                            {t('tiles.conversion.hint', { teamRate: percent(data.conversion.team), min: data.conversion.minConnects })}
                          </>
                        )
                    : t(`tiles.${x.id}.hint`);
            const title = x.label === undefined ? t(`tiles.${x.id}.title`) : t(`tiles.${x.id}.title`, { event: x.label });
            return (
              <Stat
                key={x.id}
                value={
                  x.id === 'attendance'
                    ? t('tiles.attendance.value', { attended: fmtInt(att.attended), total: fmtInt(att.attended + att.noShow) })
                    : x.id === 'conversion'
                      ? x.lowData
                        ? <span className="text-lg leading-tight">{t('tiles.conversion.empty')}</span>
                        : percent(x.rate ?? null)
                      : fmtInt(x.value)
                }
                label={
                  x.id === 'attendance' ? (
                    <Link href={`${moreHref('attendance', data)}&view=list`} className="underline underline-offset-2" data-testid="director-attendance-link">
                      {t('tiles.attendance.label', { title, rate: percent(att.rate) })}
                    </Link>
                  ) : (
                    title
                  )
                }
                hint={
                  <>
                    {extra}
                    {cmp && (
                      <>
                        <br />
                        {prev(t(`delta.${cmp.sign}`, { value: fmtInt(cmp.abs) }))}
                      </>
                    )}
                    {x.id === 'purchases' && (
                      <>
                        <br />
                        {prev(`${fmtInt(data.purchases.prevCount)} · ${money(data.purchases.prevSumKzt)}`)}
                      </>
                    )}
                  </>
                }
              />
            );
          })}
      </StatGrid>
      </DirectorBlock>

      {/* Каждая «подробнее» стоит в шапке своего блока, а не рядом внизу страницы */}
      <DirectorBlock title={t('funnel.title')} moreHref={moreHref('funnel', data)} more={t('more')}>
        <StatGrid variant="strip" className="k-statgrid--wrap2" aria-label={t('funnel.title')}>
          {FUNNEL_STEPS.map((step) => (
            <Stat key={step} value={fmtInt(data.funnel.counts[step])} label={tf(`steps.${step}`)} hint={step === 'issued' ? undefined : hintText(hints[step])} />
          ))}
        </StatGrid>
        {(hints.note || hints.withoutBooking > 0) && (
          <p className="mt-2 text-sm" style={{ color: 'var(--text-2)' }} data-testid="director-funnel-note">
            {hints.note && t('funnel.note')} {hints.withoutBooking > 0 && t('funnel.withoutBooking', { n: fmtInt(hints.withoutBooking) })}
          </p>
        )}
      </DirectorBlock>

      {lists.length > 0 && (
        <DirectorBlock title={t('reasons.title')} moreHref={moreHref('reasons', data)} more={t('more')}>
          {/* Два списка: рядом на ≥ 1024, иначе друг под другом; подписи колонок — из пресета */}
          <div className="grid min-w-0 grid-cols-1 gap-x-8 gap-y-5 lg:grid-cols-2" data-testid="director-reasons">
            {lists.map(({ role, block }) => (
              <ReasonList key={role} role={role} block={block} />
            ))}
          </div>
        </DirectorBlock>
      )}

      <DirectorBlock title={t('revenue.title')} moreHref={moreHref('revenue', data)} more={t('more')}>
        {revenueRows.length === 0 ? (
          <EmptyState title={t('revenue.empty')} />
        ) : (
          <div className="min-w-0">
            <Table caption={tr('caption')} captionHidden columns={cols} rows={revenueRows} rowKey={(r) => r.serviceTypeKey} dense stackOnMobile={false} />
          </div>
        )}
        {/* Выгрузка — под таблицей: «Подробнее» в шапке каждого блока стоит последним справа и на одной линии */}
        {canExport && (
          <div>
            <Button variant="secondary" size="sm" href={`/api/reports/revenue/export?from=${data.week.from}&to=${data.week.to}&format=csv`} external download>
              {t('export.revenue')}
            </Button>
          </div>
        )}
      </DirectorBlock>
    </Page>
  );
}
