'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { Alert, Checkbox, Chip, ChipGroup, Field, PageHeader, Select } from '@/ui/kit';
import { loadReport, queryString, type LoadFailure } from './api';
import { periodProblem } from './dates';
import { ExportBar } from './ExportBar';
import { PeriodPicker } from './PeriodPicker';
import { ReportTable } from './ReportTable';
import {
  REPORT_KEYS,
  type AttendanceBy,
  type ExportActions,
  type FunnelBy,
  type Grouping,
  type InitialReport,
  type ReportData,
  type ReportKey,
  type ReportMeta,
  type ReportQueryState,
} from './types';

type Props = { meta: ReportMeta; initialQuery: ReportQueryState; initial: InitialReport; actions: ExportActions };

/** Адрес страницы повторяет выбор: ссылкой можно поделиться. */
function urlOf(q: ReportQueryState): string {
  const sp = queryString(q);
  sp.set('r', q.key);
  return `/reports?${sp.toString()}`;
}

function isEmpty(key: ReportKey, data: ReportData): boolean {
  if (key === 'operators' || key === 'revenue' || key === 'funnel' || key === 'attendance') return 'rows' in data && data.rows.length === 0;
  return false;
}

export function ReportsScreen({ meta, initialQuery, initial, actions }: Props) {
  const t = useTranslations('reports');
  const [query, setQuery] = useState<ReportQueryState>(initialQuery);
  const [data, setData] = useState<ReportData | null>(initial.data);
  const [shownKey, setShownKey] = useState<ReportKey>(initialQuery.key);
  const [error, setError] = useState<LoadFailure | null>(initial.error);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const run = useCallback(
    async (next: ReportQueryState) => {
      setQuery(next);
      window.history.replaceState(null, '', urlOf(next));
      if (periodProblem(next.from, next.to, meta.today)) {
        setError('period_invalid');
        return;
      }
      const mine = ++seq.current;
      setBusy(true);
      const r = await loadReport(next);
      if (mine !== seq.current) return; // пришёл ответ на устаревший запрос
      setBusy(false);
      if (r.ok) {
        setData(r.data);
        setShownKey(next.key);
        setError(null);
      } else setError(r.key);
    },
    [meta.today],
  );

  const set = (patch: Partial<ReportQueryState>) => void run({ ...query, ...patch });
  const toggleUser = (id: string, on: boolean) => set({ users: on ? [...query.users, id] : query.users.filter((u) => u !== id) });
  const sourceKeys = Object.keys(meta.labels.sources);

  return (
    <>
      <PageHeader title={t('page.title')} lead={t('page.lead')} />
      <ExportBar actions={actions} query={query} disabled={periodProblem(query.from, query.to, meta.today)} />
      <ChipGroup label={t('page.tabsLabel')} className="mb-4">
        {REPORT_KEYS.map((k) => (
          <Chip key={k} active={query.key === k} onClick={() => set({ key: k })}>
            {t(`tabs.${k}`)}
          </Chip>
        ))}
      </ChipGroup>
      <section aria-label={t('filters.label')} className="mb-4 flex flex-col gap-4">
        <PeriodPicker from={query.from} to={query.to} today={meta.today} onChange={(r) => set(r)} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:max-w-3xl">
          <Field label={t('filters.source')}>
            <Select name="source" value={query.source} onChange={(e) => set({ source: e.target.value })}>
              <option value="">{t('filters.sourceAll')}</option>
              {sourceKeys.map((k) => (
                <option key={k} value={k}>
                  {meta.labels.sources[k]}
                </option>
              ))}
            </Select>
          </Field>
          {query.key === 'operators' && (
            <Field label={t('filters.group')}>
              <Select name="group" value={query.group} onChange={(e) => set({ group: e.target.value as Grouping })}>
                {(['total', 'day', 'week'] as const).map((g) => (
                  <option key={g} value={g}>
                    {t(`group.${g}`)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {query.key === 'funnel' && (
            <Field label={t('filters.by')}>
              <Select name="by" value={query.funnelBy} onChange={(e) => set({ funnelBy: e.target.value as FunnelBy })}>
                <option value="operator">{t('funnel.byOperator')}</option>
                <option value="source">{t('funnel.bySource')}</option>
              </Select>
            </Field>
          )}
          {query.key === 'attendance' && (
            <Field label={t('filters.by')}>
              <Select name="attBy" value={query.attendanceBy} onChange={(e) => set({ attendanceBy: e.target.value as AttendanceBy })}>
                {(['event_type', 'consultant', 'author'] as const).map((b) => (
                  <option key={b} value={b}>
                    {t(`attendance.by.${b}`)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {meta.staff.length > 0 && (
          <details>
            <summary className="cursor-pointer py-2">
              {t('filters.users')}: {query.users.length === 0 ? t('filters.usersAll') : t('filters.usersSelected', { count: query.users.length })}
            </summary>
            <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {meta.staff.map((s) => (
                <Checkbox key={s.userId} name={`user-${s.userId}`} label={s.name} checked={query.users.includes(s.userId)} onChange={(e) => toggleUser(s.userId, e.target.checked)} />
              ))}
            </div>
          </details>
        )}
      </section>
      {error && <Alert tone="warning">{t(`page.errors.${error}`)}</Alert>}
      <div aria-busy={busy} className={busy ? 'opacity-60' : undefined}>
        {data && !isEmpty(shownKey, data) && <ReportTable reportKey={shownKey} data={data} labels={meta.labels} />}
        {data && isEmpty(shownKey, data) && (
          <Alert tone="info">
            {t('page.empty.title')}. {t('page.empty.description')}
          </Alert>
        )}
      </div>
    </>
  );
}
