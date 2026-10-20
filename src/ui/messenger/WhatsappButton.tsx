'use client';

// Кнопка «WhatsApp» карточки (D-268): режим `link` — ссылка wa.me (по умолчанию и без подключения), режим `panel` —
// окно чата провайдера (O7a). Действие выбирает chatAction; здесь tel:/wa.me не строятся.
import { MessageCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ChannelModes } from '@/integrations/contract';
import { Button } from '@/ui/kit';
import { ChatPanel } from './ChatPanel';
import type { ConsentState } from './ConsentToggle';
import { chatAction } from './openChat';

/** «Открыт WhatsApp» в ленту: без ожидания и без влияния на открытие ссылки; офлайн не шлём. */
function reportOpened(cardId: string): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  void fetch('/api/messenger/opened', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId, templateKey: null }), keepalive: true }).catch(() => {});
}

export function WhatsappButton({ cardId, clientId, phone, modes, consent, canEditConsent }: { cardId: string; clientId: string; phone: string; modes: ChannelModes; consent: ConsentState; canEditConsent: boolean }) {
  const t = useTranslations('messenger');
  const [open, setOpen] = useState(false);
  const action = chatAction(phone, '', modes);
  const icon = <MessageCircle aria-hidden="true" />;
  if (action.kind === 'link') {
    return (
      <Button href={action.href} external target="_blank" rel="noopener noreferrer" variant="secondary" size="lg" block aria-label={t('button.aria')} onClick={() => reportOpened(cardId)}>
        {icon}
        {t('button.whatsapp')}
      </Button>
    );
  }
  return (
    <>
      <Button variant="secondary" size="lg" block aria-label={t('button.aria')} onClick={() => setOpen(true)}>
        {icon}
        {t('button.whatsapp')}
      </Button>
      <ChatPanel cardId={cardId} clientId={clientId} open={open} onClose={() => setOpen(false)} consent={consent} canEditConsent={canEditConsent} />
    </>
  );
}
