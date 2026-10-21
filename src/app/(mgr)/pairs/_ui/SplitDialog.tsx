'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Alert, Button, Field, Modal, Textarea } from '@/ui/kit';
import { call } from './api';
import type { PairRow } from './types';

/** «Выдать другому…» (PROCESS 7.6): комментарий обязателен, если общий номер рабочий у обеих сторон (проверяет сервер). */
export function SplitDialog({ pair, onClose, onDone }: { pair: PairRow; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('pairs');
  const te = useTranslations('pairs.errors');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await call<{ status: string }>('POST', `/api/distribution/pairs/${encodeURIComponent(pair.id)}/resolve`, { decision: 'split_allowed', comment });
    setBusy(false);
    if (!r.ok) return setError(r.key);
    onDone();
  }

  return (
    <Modal open onClose={onClose} title={t('split.title')} closeLabel={t('split.cancel')} description={t('split.lead')}>
      <div className="flex flex-col gap-3">
        {error && <Alert tone="danger">{te(error as 'generic')}</Alert>}
        <Field label={t('split.comment')}>
          <Textarea name="pair-comment" rows={3} maxLength={1000} value={comment} onChange={(e) => setComment(e.target.value)} />
        </Field>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {t('split.submit')}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            {t('split.cancel')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
