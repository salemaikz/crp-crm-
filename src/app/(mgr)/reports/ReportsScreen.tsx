'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Chip, ChipGroup, Field, FilterBar, Page, PageHeader, Segmented, Select } from '@/ui/kit';
import { loadReport, queryString, type LoadFailure } from './api';
import { periodProblem } from './dates';
import { ExportBar } from './ExportBar';
import { PeriodPicker } from './PeriodPicker';
import { ReportTable } from './ReportTable';
import {
  ATTENDANCE_LIST_STATUSES,
  REPORT_KEYS,
  type AttendanceBy,
  type AttendanceListData,
  type AttendanceListStatus,
  type AttendanceView,
  type ExportActions,
  type FunnelBy,
  type Grouping,
  type InitialReport,
  type ReportData,
  type ReportKey,
  type ReportMeta,
  type ReportQueryState,
} from './types';

/** Чипы-счётчики над списком явки; «запланирована» и «отменена» остаются в выпадающем фильтре. */
const CHIP_STATUSES = ['attended', 'no_show', 'unmarked'] as const satisfies readonly AttendanceListStatus[];

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

  /** Следующая страница списка явки: строки добавляются к уже показанным. */
  const loadMore = async () => {
    if (!data || !('next' in data) || data.next === null) return;
    const mine = ++seq.current;
    setBusy(true);
    const r = await loadReport(query, data.next);
    if (mine !== seq.current) return;
    setBusy(false);
    if (r.ok && 'next' in r.data) setData({ ...r.data, rows: [...(data as AttendanceListData).rows, ...r.data.rows], counts: (data as AttendanceListData).counts });
    else if (!r.ok) setError(r.key);
  };

  const set = (patch: Partial<ReportQueryState>) => void run({ ...query, ...patch });
  const toggleUser = (id: string, on: boolean) => set({ users: on ? [...query.users, id] : query.users.filter((u) => u !== id) });
  const sourceKeys = Object.keys(meta.labels.sources);

  return (
    <Page width="wide">
      <PageHeader
        title={t('page.title')}
        lead={t('page.lead')}
        actions={<ExportBar actions={actions} query={query} disabled={periodProblem(query.from, query.to, meta.today)} />}
        tabs={<Segmented label={t('page.tabsLabel')} items={REPORT_KEYS.map((k) => ({ id: k, label: t(`tabs.${k}`), active: query.key === k }))} onSelect={(k) => set({ key: k as ReportKey })} />}
      />
      <section aria-label={t('filters.label')} className="flex flex-col gap-4">
        <PeriodPicker from={query.from} to={query.to} today={meta.today} onChange={(r) => set(r)} />
        <FilterBar>
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
            <Field label={t('attendance.view.label')}>
              <Select name="attView" value={query.attendanceView} onChange={(e) => set({ attendanceView: e.target.value as AttendanceView })}>
                {(['summary', 'list'] as const).map((v) => (
                  <option key={v} value={v}>
                    {t(`attendance.view.${v}`)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {query.key === 'attendance' && query.attendanceView === 'summary' && (
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
          {query.key === 'attendance' && query.attendanceView === 'list' && (
            <>
              <Field label={t('attendance.list.filters.eventType')}>
                <Select name="listEventType" value={query.listEventType} onChange={(e) => set({ listEventType: e.target.value })}>
                  <option value="">{t('attendance.list.filters.all')}</option>
                  {Object.entries(meta.labels.eventTypes).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('attendance.list.filters.status')}>
                <Select name="listStatus" value={query.listStatus} onChange={(e) => set({ listStatus: e.target.value as '' | AttendanceListStatus })}>
                  <option value="">{t('attendance.list.filters.all')}</option>
                  {ATTENDANCE_LIST_STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {t(`attendance.list.status.${st}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('attendance.list.filters.consultant')}>
                <Select name="listConsultant" value={query.listConsultant} onChange={(e) => set({ listConsultant: e.target.value })}>
                  <option value="">{t('attendance.list.filters.all')}</option>
                  {meta.consultants.map((c) => (
                    <option key={c.userId} value={c.userId}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
        </FilterBar>
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
      {shownKey === 'attendance' && data && 'next' in data && data.counts && (
        <ChipGroup label={t('attendance.list.chips.label')} data-testid="attendance-chips">
          {CHIP_STATUSES.map((st) => (
            <Chip
              key={st}
              count={(data as AttendanceListData).counts![st]}
              active={query.listStatus === st}
              onClick={() => set({ listStatus: query.listStatus === st ? '' : st })}
              data-testid={`attendance-chip-${st}`}
            >
              {t(`attendance.list.chips.${st}`)}
            </Chip>
          ))}
        </ChipGroup>
      )}
      <div aria-busy={busy} className={busy ? 'opacity-60' : undefined}>
        {data && !isEmpty(shownKey, data) && <ReportTable reportKey={shownKey} data={data} labels={meta.labels} />}
        {data && 'next' in data && data.next !== null && (
          <div className="mt-3">
            <Button variant="secondary" size="sm" onClick={() => void loadMore()} disabled={busy}>
              {t('attendance.list.more')}
            </Button>
          </div>
        )}
        {data && isEmpty(shownKey, data) && (
          <Alert tone="info">
            {t('page.empty.title')}. {t('page.empty.description')}
          </Alert>
        )}
      </div>
    </Page>
  );
}
