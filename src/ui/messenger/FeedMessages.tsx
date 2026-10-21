'use client';

// Сообщения мессенджера в ленте клиента: день сворачивается в «Переписка: N сообщений», раскрытие — списком.
// Текст сообщения приходит с сервера вместе с лентой (охват — тот же, что у ленты); удалённое — подпись без текста.
import { useTranslations } from 'next-intl';

export type FeedMessageItem = {
  id: string;
  kind: string;
  at: number;
  data: Record<string, unknown>;
  message?: { text: string | null; deleted: boolean; status: string | null };
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const STATUSES = new Set(['sent', 'delivered', 'read', 'error', 'inbound']);

export function FeedMessages({ items, formatTime }: { items: FeedMessageItem[]; formatTime: (at: number) => string }) {
  const t = useTranslations('messenger');
  return (
    <details>
      <summary className="cursor-pointer">{t('feed.folded', { count: items.length })}</summary>
      <ul className="mt-2 flex flex-col gap-2">
        {items.map((i) => (
          <li key={i.id} className="break-words">
            {i.kind === 'messenger.link_opened' ? (
              <span>{str(i.data.templateKey) ? t('feed.linkOpenedTemplate', { template: str(i.data.templateKey) }) : t('feed.linkOpened')}</span>
            ) : (
              <MessageLine item={i} />
            )}
            <span className="text-sm text-[var(--text-2)]"> · {formatTime(i.at)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function MessageLine({ item }: { item: FeedMessageItem }) {
  const t = useTranslations('messenger');
  const incoming = item.data.direction === 'in';
  const m = item.message;
  const text = m?.deleted ? t('feed.deleted') : m?.text ? m.text : item.data.msgType === 'missing_call' ? t('feed.missingCall') : item.data.hasAttachment === true ? t('feed.attachment') : t('feed.empty');
  const status = !incoming && m?.status && STATUSES.has(m.status) ? t(`feed.status.${m.status}`) : '';
  return (
    <>
      <strong>{incoming ? t('feed.in') : t('feed.out')}: </strong>
      <span>{text}</span>
      {status && <span className="text-sm text-[var(--text-2)]"> ({status})</span>}
    </>
  );
}
