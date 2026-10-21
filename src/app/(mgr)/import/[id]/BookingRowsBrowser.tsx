'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { BOOKING_ROW_FILTERS, type BookingRowView, type RowFilter } from '../types';
import { Alert, Badge, Button, Field, Select, Table, type TableColumn } from '@/ui/kit';
import { call } from '../api';

const PAGE = 50;

/** Строки загрузки «Записей» по фильтру: что с каждой строкой будет, замечания; выгрузка CSV. */
export function BookingRowsBrowser({ importId, refreshKey, eventTypeLabels }: { importId: string; refreshKey: number; eventTypeLabels: Readonly<Record<string, string>> }) {
  const t = useTranslations('import.bookings');
  const tr = useTranslations('import.rows');
  const ta = useTranslations('import.actions');
  const te = useTranslations('import.errors');
  const f = useFormatter();
  const [filter, setFilter] = useState<RowFilter>('all');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ rows: BookingRowView[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void call<{ rows: BookingRowView[]; total: number }>('GET', `/api/import/${importId}/rows?filter=${filter}&offset=${offset}&limit=${PAGE}`).then((r) => {
      if (!alive) return;
      if (r.ok) {
        setData(r.data);
        setError(null);
      } else setError(r.code);
    });
    return () => {
      alive = false;
    };
  }, [importId, filter, offset, refreshKey]);

  const code = (c: string, ns: 'issue' | 'flag') => (t.has(`${ns}.${c}` as 'issue.bad_date') ? t(`${ns}.${c}` as 'issue.bad_date') : c);
  const columns: TableColumn<BookingRowView>[] = [
    { key: 'no', header: t('rows.columns.row'), cell: (r) => r.rowNo, width: '72px' },
    { key: 'name', header: t('rows.columns.name'), primary: true, cell: (r) => <strong>{r.name || '—'}</strong> },
    { key: 'phones', header: t('rows.columns.phones'), hideOnMobile: true, cell: (r) => r.phones.join(', ') || '—' },
    {
      key: 'event',
      header: t('rows.columns.event'),
      cell: (r) => [r.eventDate ? f.dateTime(Date.parse(`${r.eventDate}T12:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' }) : '—', r.eventTime ?? '', r.eventTypeKey ? (eventTypeLabels[r.eventTypeKey] ?? r.eventTypeKey) : r.eventTypeRaw].filter(Boolean).join(' · '),
    },
    { key: 'author', header: t('rows.columns.author'), hideOnMobile: true, cell: (r) => r.authorLabel ?? '—' },
    {
      key: 'action',
      header: t('rows.columns.action'),
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={r.action === 'invalid' ? 'danger' : r.action === 'create' ? 'success' : 'neutral'}>{t(`action.${r.action}`)}</Badge>
          {r.flags.map((x) => (
            <Badge key={x} tone="warning">
              {code(x, 'flag')}
            </Badge>
          ))}
        </span>
      ),
    },
    { key: 'issues', header: t('rows.columns.issues'), hideOnMobile: true, cell: (r) => r.issues.map((c) => code(c, 'issue')).join(', ') || '—' },
  ];
  const total = data?.total ?? 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={tr('filter')}>
          <Select
            name="filter"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as RowFilter);
              setOffset(0);
            }}
          >
            {BOOKING_ROW_FILTERS.map((x) => (
              <option key={x} value={x}>
                {t(`filters.${x}` as 'filters.all')}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" href={`/api/import/${importId}/rows.csv?filter=${filter}`} external download>
          <Download aria-hidden="true" size={18} /> {tr('download')}
        </Button>
      </div>
      {error && <Alert tone="danger">{te.has(error as 'generic') ? te(error as 'generic') : te('generic')}</Alert>}
      <Table columns={columns} rows={data?.rows ?? []} rowKey={(r) => String(r.rowNo)} dense empty={<p>{tr('empty')}</p>} />
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          {ta('prev')}
        </Button>
        <span>{tr('range', { from: total === 0 ? 0 : offset + 1, to: Math.min(offset + PAGE, total), total: f.number(total) })}</span>
        <Button variant="secondary" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
          {ta('next')}
        </Button>
      </div>
    </div>
  );
}
