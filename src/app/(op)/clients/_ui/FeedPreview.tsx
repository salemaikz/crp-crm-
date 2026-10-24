'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { formatDateTime } from './format';
import type { FeedItemView, FeedLabels } from './types';
import { useFeedDescribe } from './useFeedDescribe';

/** Группы превью: без «Системы» (правки полей, номеров, раздача) — в шторке нужны звонки, записи, сделки, заметки. */
const PREVIEW_GROUPS = 'calls,messages,bookings,deals,tasks,notes';

type Props = {
  clientId: string;
  /** Подписи из `feedLabelsFor(viewer)`: те же, что у «Истории» карточки. */
  labels: FeedLabels;
  /** Сколько последних событий показать (1–20, по умолчанию 3). */
  limit?: number;
};

/** Последние события клиента (контракт К2): читает `GET /api/clients/[id]/feed?limit=N`, чужой клиент — пустой ответ 404. */
export function FeedPreview({ clientId, labels, limit = 3 }: Props) {
  const t = useTranslations('clients');
  const describe = useFeedDescribe(labels, labels.timeZone);
  // Результат помнит, для какого запроса получен: смена клиента или размера снова показывает «загрузка» без setState в эффекте
  const n = Math.min(20, Math.max(1, Math.trunc(limit)));
  const key = `${clientId}:${n}`;
  const [result, setResult] = useState<{ key: string; items: FeedItemView[] | null } | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/clients/${encodeURIComponent(clientId)}/feed?limit=${n}&groups=${PREVIEW_GROUPS}`, { signal: ctl.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('feed');
        const page = (await res.json()) as { items: FeedItemView[] };
        setResult({ key, items: page.items });
      })
      .catch((e: unknown) => {
        if ((e as { name?: string }).name !== 'AbortError') setResult({ key, items: null });
      });
    return () => ctl.abort();
  }, [clientId, n, key]);

  const current = result?.key === key ? result : null;
  const items = current?.items ?? null;

  if (current !== null && items === null) return <p className="text-sm text-[var(--danger)]">{t('feed.loadFailed')}</p>;
  if (current === null || items === null) return <p className="text-sm text-[var(--text-2)]">{t('form.loading')}</p>;
  if (items.length === 0) return <p className="text-sm text-[var(--text-2)]">{t('feed.emptyTitle')}</p>;
  return (
    <ol className="flex flex-col divide-y divide-[var(--border)]" data-testid="feed-preview">
      {items.map((i) => (
        <li key={i.id} className="py-1.5">
          <p className="break-words text-sm">{describe(i)}</p>
          {i.call && i.call.note !== '' && <p className="mt-0.5 line-clamp-3 break-words whitespace-pre-wrap text-sm text-[var(--text-2)]">{i.call.note}</p>}
          {i.note && <p className="mt-0.5 line-clamp-3 break-words whitespace-pre-wrap text-sm text-[var(--text-2)]">{i.note.body}</p>}
          <p className="text-xs text-[var(--text-2)]">
            {formatDateTime(i.at, labels.timeZone)}
            {i.actor ? ` · ${i.actor.name}` : ''}
          </p>
        </li>
      ))}
    </ol>
  );
}
