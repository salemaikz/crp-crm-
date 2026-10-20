'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowLeft, Check, RefreshCw } from 'lucide-react';
import { Alert, Badge, Button, Card, PageHeader } from '@/ui/kit';
import { call } from '../api';
import type { ApplyBlocker, ApplyResult, ImportDetails, PreviewSummary } from '../types';
import { ApplyDialog } from './ApplyDialog';
import { OwnerMapForm } from './OwnerMapForm';
import { RowsBrowser } from './RowsBrowser';
import { CountsView, SummaryView } from './SummaryView';

type Props = { details: ImportDetails; sameFileAppliedAt: number | null };

/** Одна загрузка: карта владельцев → предпросмотр → «Применить» → что записано. */
export function DetailScreen({ details, sameFileAppliedAt }: Props) {
  const t = useTranslations('import');
  const te = useTranslations('import.errors');
  const f = useFormatter();
  const router = useRouter();
  const [ownerMap, setOwnerMap] = useState<Record<string, string>>({ ...details.savedOwnerMap });
  const [summary, setSummary] = useState<PreviewSummary | null>(null);
  const [applied, setApplied] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [blockers, setBlockers] = useState<readonly ApplyBlocker[]>([]);
  const [tick, setTick] = useState(0);

  const alreadyApplied = details.status === 'applied' || applied !== null;
  const written = applied?.written ?? details.report.apply?.written ?? null;
  const expired = details.rowsExpired;

  async function runPreview() {
    setBusy(true);
    setError(null);
    setStale(false);
    const r = await call<PreviewSummary>('POST', `/api/import/${details.id}/preview`, { ownerMap });
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
    const r = await call<ApplyResult>('POST', `/api/import/${details.id}/apply`, { fingerprint: summary.fingerprint, ownerMap });
    setBusy(false);
    setConfirm(false);
    if (r.ok) {
      setApplied(r.data);
      router.refresh();
      return;
    }
    if (r.code === 'preview_stale') {
      setStale(true);
      if (r.body.summary) setSummary(r.body.summary as PreviewSummary);
      setTick((x) => x + 1);
    } else if (r.code === 'blocked' && Array.isArray(r.body.blockers)) setBlockers(r.body.blockers as ApplyBlocker[]);
    setError(r.code);
  }

  const errText = (code: string) => (te.has(code as 'generic') ? te(code as 'generic') : te('generic'));
  const canApply = !!summary && !alreadyApplied && blockers.length === 0 && !stale;

  return (
    <>
      <PageHeader
        breadcrumbs={
          <Button variant="quiet" size="sm" href="/import">
            <ArrowLeft aria-hidden="true" size={16} /> {t('detail.back')}
          </Button>
        }
        title={details.fileName || t('list.noName')}
        lead={t('detail.lead', { rows: f.number(details.rows), at: f.dateTime(details.createdAt, { dateStyle: 'medium', timeStyle: 'short' }) })}
        actions={<Badge tone={alreadyApplied ? 'success' : details.status === 'failed' ? 'danger' : 'info'}>{t(`status.${alreadyApplied ? 'applied' : details.status}`)}</Badge>}
      />
      <div className="flex flex-col gap-6">
        {sameFileAppliedAt !== null && <Alert tone="info">{t('detail.sameFile', { at: f.dateTime(sameFileAppliedAt, { dateStyle: 'medium', timeStyle: 'short' }) })}</Alert>}
        {expired && <Alert tone="warning">{t('detail.expired')}</Alert>}
        {error && (
          <Alert tone={stale ? 'warning' : 'danger'}>
            {errText(error)}
            {blockers.length > 0 && <> {blockers.map((b) => t(`blockers.${b}`)).join('; ')}</>}
          </Alert>
        )}
        {alreadyApplied && written && (
          <Card>
            <h2 className="mb-3 text-lg font-semibold">{t('result.title')}</h2>
            {applied?.alreadyApplied && <p className="mb-3">{t('result.again')}</p>}
            <CountsView w={written} />
          </Card>
        )}
        {!alreadyApplied && !expired && (
          <Card>
            <h2 className="mb-3 text-lg font-semibold">{t('owners.title')}</h2>
            <p className="mb-3">{t('owners.lead')}</p>
            <OwnerMapForm labels={details.ownerLabels} candidates={details.candidates} value={ownerMap} onChange={setOwnerMap} disabled={busy} />
            <div className="mt-4">
              <Button variant="secondary" onClick={runPreview} disabled={busy}>
                <RefreshCw aria-hidden="true" size={18} /> {summary ? t('actions.recheck') : t('actions.preview')}
              </Button>
            </div>
          </Card>
        )}
        {summary && !alreadyApplied && (
          <Card>
            <h2 className="mb-3 text-lg font-semibold">{t('summary.title')}</h2>
            <SummaryView s={summary} />
            <div className="mt-4">
              <Button onClick={() => setConfirm(true)} disabled={!canApply || busy}>
                <Check aria-hidden="true" size={18} /> {t('actions.apply')}
              </Button>
            </div>
          </Card>
        )}
        {!expired && (summary || alreadyApplied) && (
          <Card>
            <h2 className="mb-3 text-lg font-semibold">{t('rows.title')}</h2>
            <RowsBrowser importId={details.id} refreshKey={tick} />
          </Card>
        )}
      </div>
      {summary && <ApplyDialog open={confirm} summary={summary} busy={busy} onConfirm={runApply} onClose={() => setConfirm(false)} />}
    </>
  );
}
