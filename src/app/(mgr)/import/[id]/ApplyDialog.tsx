'use client';

import { useTranslations } from 'next-intl';
import { Alert, Button, Modal } from '@/ui/kit';
import type { PreviewSummary } from '../types';

type Props = {
  open: boolean;
  summary: PreviewSummary;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

/** Подтверждение «Применить»: итог в одной строке и напоминание о копии БД (отката импорта нет, D-113). */
export function ApplyDialog({ open, summary, busy, onConfirm, onClose }: Props) {
  const t = useTranslations('import.apply');
  const assigned = summary.perOperator.reduce((a, o) => a + o.count, 0);
  return (
    <Modal
      open={open}
      onClose={onClose}
      closeLabel={t('close')}
      title={t('title')}
      dismissible={!busy}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            {busy ? t('applying') : t('confirm')}
          </Button>
        </>
      }
    >
      <p>
        {t('summary', {
          create: summary.counts.byAction.create,
          update: summary.counts.byAction.update_state,
          merge: summary.counts.byAction.merge,
          assigned,
          operators: summary.perOperator.length,
        })}
      </p>
      <Alert tone="warning" className="mt-3">
        {t('backup')}
      </Alert>
    </Modal>
  );
}
