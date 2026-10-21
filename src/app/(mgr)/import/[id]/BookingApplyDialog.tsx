'use client';

import { useTranslations } from 'next-intl';
import { Alert, Button, Modal } from '@/ui/kit';
import type { BookingPreviewSummary } from '../types';

type Props = { open: boolean; summary: BookingPreviewSummary; busy: boolean; onConfirm: () => void; onClose: () => void };

/** Подтверждение «Применить» для «Записей»: итог в одной строке и напоминание о копии БД (отката импорта нет, D-113). */
export function BookingApplyDialog({ open, summary, busy, onConfirm, onClose }: Props) {
  const t = useTranslations('import.apply');
  const tb = useTranslations('import.bookings.apply');
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
      <p>{tb('summary', { create: summary.counts.byAction.create, agreed: summary.willAgree, clarify: summary.clarifyToClose })}</p>
      <Alert tone="warning" className="mt-3">
        {tb('backup')}
      </Alert>
    </Modal>
  );
}
