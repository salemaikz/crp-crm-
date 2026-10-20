'use client';

// Окно чата провайдера в карточке (D-270, дизайн §8.7): одноразовая ссылка запрашивается у сервера при каждом
// открытии, нигде не сохраняется и после закрытия забывается (содержимое размонтируется). Имя клиента в запросе не
// передаётся — только id карточки.
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Alert, BottomSheet, Button } from '@/ui/kit';
import { ConsentToggle, type ConsentState } from './ConsentToggle';

type Load = { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'error'; key: string };

const KEYS: Record<string, string> = {
  messenger_unavailable: 'unavailable',
  no_phone: 'noPhone',
  no_channel: 'noChannel',
  provider_error: 'providerError',
  rate_limited: 'rateLimited',
};

type Props = { cardId: string; clientId: string; open: boolean; onClose: () => void; consent: ConsentState; canEditConsent: boolean };

export function ChatPanel({ open, onClose, ...rest }: Props) {
  const t = useTranslations('messenger');
  return (
    <BottomSheet open={open} onClose={onClose} title={t('chat.title')} closeLabel={t('chat.close')}>
      {open && <ChatBody {...rest} />}
    </BottomSheet>
  );
}

/** Каждое открытие — новый экземпляр: запрос ссылки, ожидание, окно или понятная ошибка. */
function ChatBody({ cardId, clientId, consent, canEditConsent }: Omit<Props, 'open' | 'onClose'>) {
  const t = useTranslations('messenger');
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/messenger/chat-window', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId }) });
        const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
        if (cancelled) return;
        if (res.ok && typeof body?.url === 'string') setLoad({ kind: 'ready', url: body.url });
        else setLoad({ kind: 'error', key: KEYS[body?.error ?? ''] ?? 'error' });
      } catch {
        if (!cancelled) setLoad({ kind: 'error', key: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  return (
    <div className="flex min-h-[60vh] flex-col gap-3">
      <ConsentToggle clientId={clientId} initial={consent} canEdit={canEditConsent} />
      {load.kind === 'loading' && <p role="status">{t('chat.loading')}</p>}
      {load.kind === 'error' && <Alert tone="danger">{t(`chat.${load.key}`)}</Alert>}
      {load.kind === 'ready' && (
        <>
          <iframe src={load.url} title={t('chat.title')} allow="microphone *; clipboard-write *" referrerPolicy="no-referrer" className="min-h-[55vh] w-full flex-1 rounded-[12px] border border-[var(--border)]" />
          <Button href={load.url} external variant="quiet" size="sm" target="_blank" rel="noopener noreferrer">
            {t('chat.newTab')}
          </Button>
        </>
      )}
    </div>
  );
}
