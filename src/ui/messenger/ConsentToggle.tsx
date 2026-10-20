'use client';

// Отметка «клиент согласен на переписку и передачу данных за рубеж» (INTEGRATIONS §3.2 п. 12). Сервер пишет в consents
// sha256 показанного текста; отзыв — новая строка. Без отметки окно чата открывается с предупреждением (D-270).
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Badge, Button } from '@/ui/kit';

export type ConsentState = 'given' | 'revoked' | null;

export function ConsentToggle({ clientId, initial, canEdit }: { clientId: string; initial: ConsentState; canEdit: boolean }) {
  const t = useTranslations('messenger');
  const [state, setState] = useState<ConsentState>(initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function save(action: 'given' | 'revoked'): Promise<void> {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch('/api/messenger/consent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, action }) });
      if (!res.ok) throw new Error('consent');
      setState(action);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const given = state === 'given';
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label={t('consent.label')}>
      <Badge tone={given ? 'success' : 'warning'}>{given ? t('consent.given') : state === 'revoked' ? t('consent.revoked') : t('chat.consentMissing')}</Badge>
      {canEdit && (
        <Button variant="quiet" size="sm" disabled={busy} onClick={() => void save(given ? 'revoked' : 'given')}>
          {given ? t('consent.revoke') : t('consent.mark')}
        </Button>
      )}
      {failed && <span className="text-[var(--danger)]">{t('consent.error')}</span>}
    </div>
  );
}
