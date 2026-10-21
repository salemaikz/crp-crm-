'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button } from '@/ui/kit';

/** Главная кнопка экрана: отметить всё прочитанным и обновить страницу (бейдж оболочки — тоже). */
export function MarkAllRead() {
  const t = useTranslations('notify');
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function markAll() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch('/api/notify/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }) });
      if (res.status === 401) {
        window.location.replace('/login?next=/notifications');
        return;
      }
      if (!res.ok) throw new Error('read');
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="quiet" size="sm" onClick={markAll} disabled={busy}>
        {t('markAll')}
      </Button>
      {failed && <Alert tone="danger">{t('error')}</Alert>}
    </>
  );
}
