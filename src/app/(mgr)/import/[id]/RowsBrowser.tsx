'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { ROW_FILTERS, type ImportRowView, type RowFilter } from '../types';
import { Alert, Badge, Button, Field, Select, Table, type TableColumn } from '@/ui/kit';
import { call } from '../api';

const PAGE = 50;

/** Строки загрузки по фильтру: номер строки таблицы, что с ней будет, замечания; выгрузка CSV. */
export function RowsBrowser({ importId, refreshKey }: { importId: string; refreshKey: number }) {
  const t = useTranslations('import.rows');
  const ta = useTranslations('import.actions');
  const te = useTranslations('import.errors');
  const f = useFormatter();
  const [filter, setFilter] = useState<RowFilter>('all');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ rows: ImportRowView[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void call<{ rows: ImportRowView[]; total: number }>('GET', `/api/import/${importId}/rows?filter=${filter}&offset=${offset}&limit=${PAGE}`).then((r) => {
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

  const columns: TableColumn<ImportRowView>[] = [
    { key: 'no', header: t('columns.row'), cell: (r) => r.rowNo, width: '72px' },
    { key: 'name', header: t('columns.name'), primary: true, cell: (r) => <strong>{r.name}</strong> },
    { key: 'phones', header: t('columns.phones'), cell: (r) => r.phones.join(', ') },
    { key: 'operator', header: t('columns.operator'), hideOnMobile: true, cell: (r) => r.operatorLabel ?? '—' },
    { key: 'answer', header: t('columns.answer'), hideOnMobile: true, cell: (r) => r.answerRaw || '—' },
    {
      key: 'action',
      header: t('columns.action'),
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-2">
          <Badge tone={r.action === 'invalid' ? 'danger' : r.action === 'create' || r.action === 'merge' ? 'success' : 'neutral'}>{t(`action.${r.action}`)}</Badge>
          {r.hold && <Badge tone="warning">{t(`hold.${r.hold}`)}</Badge>}
        </span>
      ),
    },
    { key: 'issues', header: t('columns.issues'), hideOnMobile: true, cell: (r) => [...r.issues, ...r.noteFlags].map((c) => (t.has(`issue.${c}` as 'issue.no_name') ? t(`issue.${c}` as 'issue.no_name') : c)).join(', ') || '—' },
  ];
  const total = data?.total ?? 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('filter')}>
          <Select
            name="filter"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value as RowFilter);
              setOffset(0);
            }}
          >
            {ROW_FILTERS.map((x) => (
              <option key={x} value={x}>
                {t(`filters.${x}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Button variant="secondary" href={`/api/import/${importId}/rows.csv?filter=${filter}`} external download>
          <Download aria-hidden="true" size={18} /> {t('download')}
        </Button>
      </div>
      {error && <Alert tone="danger">{te.has(error as 'generic') ? te(error as 'generic') : te('generic')}</Alert>}
      <Table columns={columns} rows={data?.rows ?? []} rowKey={(r) => String(r.rowNo)} dense empty={<p>{t('empty')}</p>} />
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
          {ta('prev')}
        </Button>
        <span>{t('range', { from: total === 0 ? 0 : offset + 1, to: Math.min(offset + PAGE, total), total: f.number(total) })}</span>
        <Button variant="secondary" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
          {ta('next')}
        </Button>
      </div>
    </div>
  );
}
