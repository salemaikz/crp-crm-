'use client';

import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { Alert, Button, Card, Input, Select, Table, type TableColumn } from '@/ui/kit';
import { send } from './api';
import type { Holiday, SalesSettingsView } from './types';

type Props = { data: SalesSettingsView; onSaved: (v: SalesSettingsView) => void; onConflict: () => void };

const MAX_ROWS = 300;
type Row = Holiday & { id: number };

/** Календарь на текущий и следующий год. Строки других лет сохраняются как есть. */
export function HolidaysEditor({ data, onSaved, onConflict }: Props) {
  const t = useTranslations('settings.holidays');
  const [rows, setRows] = useState<Row[]>(() => data.holidays.map((h, i) => ({ ...h, id: i })));
  const [nextId, setNextId] = useState(data.holidays.length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const editable = data.can.holidays;

  const years = [String(data.year), String(data.year + 1)];
  const shown = rows.filter((r) => r.date === '' || years.includes(r.date.slice(0, 4))).sort((a, b) => (a.date === '' ? 1 : b.date === '' ? -1 : a.date < b.date ? -1 : 1));

  const patchRow = (id: number, p: Partial<Holiday>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const add = (kind: Holiday['kind']) => {
    setRows((rs) => [...rs, { id: nextId, date: '', kind, note: '' }]);
    setNextId(nextId + 1);
    setSaved(false);
  };

  const fmt = (date: string) => new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !editable) return;
    setError(null);
    setSaved(false);
    const dates = rows.map((r) => r.date);
    if (rows.length > MAX_ROWS) return setError(t('tooMany'));
    if (dates.some((d) => d === '') || new Set(dates).size !== dates.length) return setError(t('invalid'));
    setBusy(true);
    const r = await send('PUT', '/api/admin/settings/holidays', {
      expectedRev: { global: data.revs.global },
      holidays: rows.map(({ date, kind, note }) => ({ date, kind, note: note.trim() })),
    });
    setBusy(false);
    if (r.ok) {
      setSaved(true);
      onSaved(r.data);
    } else if (r.key === 'conflict') onConflict();
    else setError(r.key === 'invalid' ? t('invalid') : t('failed'));
  }

  const columns: TableColumn<Row>[] = [
    {
      key: 'date',
      header: t('date'),
      primary: true,
      cell: (r) =>
        editable ? (
          <Input type="date" aria-label={t('date')} value={r.date} onChange={(e) => patchRow(r.id, { date: e.target.value })} />
        ) : (
          fmt(r.date)
        ),
    },
    {
      key: 'kind',
      header: t('kind'),
      cell: (r) =>
        editable ? (
          <Select aria-label={t('kind')} value={r.kind} onChange={(e) => patchRow(r.id, { kind: e.target.value as Holiday['kind'] })}>
            <option value="holiday">{t('holiday')}</option>
            <option value="workday">{t('workday')}</option>
          </Select>
        ) : (
          t(r.kind)
        ),
    },
    {
      key: 'note',
      header: t('note'),
      cell: (r) =>
        editable ? (
          <Input aria-label={t('note')} maxLength={100} value={r.note} onChange={(e) => patchRow(r.id, { note: e.target.value })} />
        ) : (
          r.note
        ),
    },
  ];
  if (editable) {
    columns.push({
      key: 'remove',
      header: '',
      align: 'right',
      cell: (r) => (
        <Button variant="quiet" size="sm" iconOnly aria-label={t('removeRow', { date: r.date || '—' })} onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}>
          <Trash2 aria-hidden="true" size={18} />
        </Button>
      ),
    });
  }

  return (
    <Card as="section" aria-labelledby="holidays-title">
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <div>
          <h2 id="holidays-title" className="text-lg font-semibold">
            {t('title')}
          </h2>
          <p className="k-field__hint">{t('lead')}</p>
        </div>
        {!editable && <Alert tone="info">{t('adminOnly')}</Alert>}
        <Table columns={columns} rows={shown} rowKey={(r) => String(r.id)} dense empty={t('empty')} />
        {editable && (
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => add('holiday')}>
              {t('add')}
            </Button>
            <Button variant="secondary" onClick={() => add('workday')}>
              {t('workday')}
            </Button>
          </div>
        )}
        {editable && <p className="k-field__hint">{t('hint')}</p>}
        {error && <Alert tone="danger">{error}</Alert>}
        {saved && <Alert tone="success">{t('saved')}</Alert>}
        {editable && (
          <div>
            <Button type="submit" disabled={busy}>
              {t('save')}
            </Button>
          </div>
        )}
      </form>
    </Card>
  );
}
