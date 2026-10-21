'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Upload } from 'lucide-react';
import { ActionBar, Alert, Button, Field, FormGrid, Input, Select } from '@/ui/kit';
import { uploadFile } from './api';
import type { ProfileOption, UploadResult } from './types';

type Props = { profiles: ProfileOption[]; today: string };

/** Загрузка CSV или XLSX: профиль, файл, лист (после ответа sheet_required), дата снимка таблицы. */
export function UploadForm({ profiles, today }: Props) {
  const t = useTranslations('import.upload');
  const tb = useTranslations('import.bookings');
  const te = useTranslations('import.errors');
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [profile, setProfile] = useState(profiles[0]?.key ?? '');
  const [day, setDay] = useState(today);
  const [sheet, setSheet] = useState('');
  const [sheets, setSheets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!file) {
      setError('no_file');
      return;
    }
    setBusy(true);
    setError(null);
    setMissing([]);
    const q = new URLSearchParams({ profile, snapshotDay: day, ...(sheet ? { sheet } : {}) });
    const r = await uploadFile<UploadResult>(`/api/import/uploads?${q.toString()}`, file);
    setBusy(false);
    if (r.ok) {
      const same = r.data.sameFileApplied;
      router.push(`/import/${r.data.importId}${same ? `?same=${same.appliedAt}` : ''}`);
      return;
    }
    if (r.code === 'sheet_required' && Array.isArray(r.body.sheets)) {
      setSheets(r.body.sheets as string[]);
      setSheet((r.body.sheets as string[])[0] ?? '');
    }
    if (r.code === 'header_not_found' && Array.isArray(r.body.missing)) setMissing(r.body.missing as string[]);
    setError(r.code);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-[var(--space-stack)]" noValidate>
      {error && (
        <Alert tone={error === 'sheet_required' ? 'info' : 'danger'}>
          {te.has(error as 'generic') ? te(error as 'generic') : error === 'no_file' ? t('noFile') : te('generic')}
          {missing.length > 0 && <> {t('missing', { fields: missing.join(', ') })}</>}
        </Alert>
      )}
      <FormGrid>
        <Field label={t('profile')} width="md" hint={profiles.find((p) => p.key === profile)?.kind === 'bookings' ? tb('lead') : undefined} required>
          <Select name="profile" value={profile} onChange={(e) => setProfile(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('file')} width="md" hint={t('fileHint')} required>
          <Input name="file" type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        {sheets.length > 0 && (
          <Field label={t('sheet')} width="md" required>
            <Select name="sheet" value={sheet} onChange={(e) => setSheet(e.target.value)}>
              {sheets.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('snapshotDay')} width="sm" hint={t('snapshotDayHint')} required>
          <Input name="snapshotDay" type="date" max={today} value={day} onChange={(e) => setDay(e.target.value)} />
        </Field>
      </FormGrid>
      <ActionBar>
        <Button type="submit" disabled={busy || profiles.length === 0}>
          <Upload aria-hidden="true" size={18} /> {busy ? t('uploading') : t('submit')}
        </Button>
      </ActionBar>
    </form>
  );
}
