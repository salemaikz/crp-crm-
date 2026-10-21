'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Check, RefreshCw } from 'lucide-react';
import { ActionBar, Alert, Button, Card, Page } from '@/ui/kit';
import { call } from '../api';
import type { ApplyBlocker, BookingApplyResult, BookingPreviewSummary, ImportDetails } from '../types';
import { AuthorMapForm, authorMapOf, initialChoice, type AuthorChoice } from './AuthorMapForm';
import { BookingApplyDialog } from './BookingApplyDialog';
import { BookingRowsBrowser } from './BookingRowsBrowser';
import { BookingCountsView, BookingSummaryView } from './BookingSummaryView';
import { DetailHeader } from './DetailHeader';

type Props = { details: ImportDetails; sameFileAppliedAt: number | null };

/** Одна загрузка таблицы записей (D-324): карта авторов → предпросмотр → «Применить» → что записано. */
export function BookingsDetail({ details, sameFileAppliedAt }: Props) {
  const t = useTranslations('import');
  const tb = useTranslations('import.bookings');
  const te = useTranslations('import.errors');
  const f = useFormatter();
  const router = useRouter();
  const data = details.bookings;
  const [choice, setChoice] = useState<AuthorChoice>(() => (data ? initialChoice(data) : {}));
  const [summary, setSummary] = useState<BookingPreviewSummary | null>(null);
  const [applied, setApplied] = useState<BookingApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [blockers, setBlockers] = useState<readonly ApplyBlocker[]>([]);
  const [tick, setTick] = useState(0);

  const alreadyApplied = details.status === 'applied' || applied !== null;
  const stamp = details.report.apply;
  const written = applied?.written ?? (stamp?.kind === 'bookings' ? stamp.written : null);
  const expired = details.rowsExpired;

  async function runPreview() {
    setBusy(true);
    setError(null);
    setStale(false);
    const r = await call<BookingPreviewSummary>('POST', `/api/import/${details.id}/preview`, { ownerMap: {}, authorMap: authorMapOf(choice) });
    setBusy(false);
    if (r.ok) {
      setSummary(r.data);
      setBlockers(r.data.blockers);
      setTick((x) => x + 1);
    } else setError(r.code);
  }

  async function runApply() {
    if (!summary) return;
    setBusy(true);
    setError(null);
    const r = await call<BookingApplyResult>('POST', `/api/import/${details.id}/apply`, { fingerprint: summary.fingerprint, ownerMap: {}, authorMap: authorMapOf(choice) });
    setBusy(false);
    setConfirm(false);
    if (r.ok) {
      setApplied(r.data);
      router.refresh();
      return;
    }
    if (r.code === 'preview_stale') {
      setStale(true);
      if (r.body.summary) setSummary(r.body.summary as BookingPreviewSummary);
      setTick((x) => x + 1);
    } else if (r.code === 'blocked' && Array.isArray(r.body.blockers)) setBlockers(r.body.blockers as ApplyBlocker[]);
    setError(r.code);
  }

  const errText = (code: string) => (te.has(code as 'generic') ? te(code as 'generic') : te('generic'));
  const canApply = !!summary && !alreadyApplied && blockers.length === 0 && !stale;

  return (
    <Page width="wide" header={<DetailHeader details={details} applied={alreadyApplied} />}>
      {sameFileAppliedAt !== null && <Alert tone="info">{t('detail.sameFile', { at: f.dateTime(sameFileAppliedAt, { dateStyle: 'medium', timeStyle: 'short' }) })}</Alert>}
      {expired && <Alert tone="warning">{t('detail.expired')}</Alert>}
      {error && (
        <Alert tone={stale ? 'warning' : 'danger'}>
          {errText(error)}
          {blockers.length > 0 && <> {blockers.map((b) => t(`blockers.${b}`)).join('; ')}</>}
        </Alert>
      )}
      {alreadyApplied && written && (
        <Card title={tb('result.title')}>
          {applied?.alreadyApplied && <p className="mb-3">{t('result.again')}</p>}
          <BookingCountsView w={written} />
        </Card>
      )}
      {!alreadyApplied && !expired && data && (
        <Card title={tb('authors.title')}>
          <div className="flex flex-col gap-[var(--space-stack)]">
            <p>{tb('authors.lead')}</p>
            <AuthorMapForm hints={data.hints} staff={data.staff} value={choice} onChange={setChoice} disabled={busy} />
            <ActionBar>
              <Button variant="secondary" onClick={runPreview} disabled={busy}>
                <RefreshCw aria-hidden="true" size={18} /> {summary ? t('actions.recheck') : t('actions.preview')}
              </Button>
            </ActionBar>
          </div>
        </Card>
      )}
      {summary && !alreadyApplied && (
        <Card title={tb('summary.title')}>
          <div className="flex flex-col gap-[var(--space-stack)]">
            <BookingSummaryView s={summary} />
            <ActionBar>
              <Button onClick={() => setConfirm(true)} disabled={!canApply || busy}>
                <Check aria-hidden="true" size={18} /> {t('actions.apply')}
              </Button>
            </ActionBar>
          </div>
        </Card>
      )}
      {!expired && (summary || alreadyApplied) && (
        <Card title={tb('rows.title')}>
          <BookingRowsBrowser importId={details.id} refreshKey={tick} eventTypeLabels={data?.eventTypeLabels ?? {}} />
        </Card>
      )}
      {summary && <BookingApplyDialog open={confirm} summary={summary} busy={busy} onConfirm={runApply} onClose={() => setConfirm(false)} />}
    </Page>
  );
}
