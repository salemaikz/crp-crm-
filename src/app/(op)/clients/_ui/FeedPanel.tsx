'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Button, Card, Chip, ChipGroup, EmptyState } from '@/ui/kit';
import { describeEvent, makeContext } from './feedLabels';
import { formatDateTime } from './format';
import type { FeedItemView, FeedLabels } from './types';

const GROUPS = ['calls', 'messages', 'bookings', 'deals', 'tasks', 'notes', 'system'] as const;

type Props = {
  clientId: string;
  initialItems: FeedItemView[];
  initialNext: string | null;
  timeZone: string;
  labels: FeedLabels;
};

type Page = { items: FeedItemView[]; next: string | null };

export function FeedPanel({ clientId, initialItems, initialNext, timeZone, labels }: Props) {
  const t = useTranslations('clients');
  const context = makeContext(labels, {
    yes: t('fields.yes'),
    no: t('fields.no'),
    empty: t('feed.emptyValue'),
    system: (key) => t(key),
    unknownField: t('feed.unknownField'),
    unknownPhone: t('feed.unknownPhone'),
    unknownContact: t('feed.unknownContact'),
  });
  const [group, setGroup] = useState<string | null>(null);
  const [items, setItems] = useState(initialItems);
  const [next, setNext] = useState(initialNext);
  const [showSystem, setShowSystem] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function load(g: string | null, cursor: string | null, append: boolean) {
    setBusy(true);
    setFailed(false);
    try {
      const q = new URLSearchParams();
      if (g) q.set('groups', g);
      if (cursor) q.set('cursor', cursor);
      const res = await fetch(`/api/clients/${clientId}/feed?${q.toString()}`);
      if (!res.ok) throw new Error('feed');
      const page = (await res.json()) as Page;
      setItems((cur) => (append ? [...cur, ...page.items] : page.items));
      setNext(page.next);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  function choose(g: string | null) {
    setGroup(g);
    setShowSystem(false);
    void load(g, null, false);
  }

  // Системные события свёрнуты в одну строку, пока не выбрана группа «Система» или не раскрыты
  const system = items.filter((i) => i.group === 'system');
  const collapse = group !== 'system' && !showSystem && system.length > 0;
  const visible = collapse ? items.filter((i) => i.group !== 'system') : items;

  return (
    <Card as="section" aria-labelledby="client-feed-title">
      <h2 id="client-feed-title" className="mb-3 text-lg font-semibold">
        {t('feed.title')}
      </h2>
      <ChipGroup label={t('feed.groups')} className="mb-3">
        <Chip active={group === null} onClick={() => choose(null)}>
          {t('feed.all')}
        </Chip>
        {GROUPS.map((g) => (
          <Chip key={g} active={group === g} onClick={() => choose(g)}>
            {t(`feed.group.${g}`)}
          </Chip>
        ))}
      </ChipGroup>
      {collapse && (
        <Button variant="quiet" size="sm" className="mb-2" onClick={() => setShowSystem(true)}>
          {t('feed.systemCollapsed', { count: system.length })}
        </Button>
      )}
      {visible.length === 0 ? (
        <EmptyState framed={false} headingLevel="h3" title={t('feed.emptyTitle')} description={t('feed.emptyText')} />
      ) : (
        <ol className="flex flex-col divide-y divide-[var(--border)]">
          {visible.map((i) => {
            const d = describeEvent(i, context);
            return (
              <li key={i.id} className="py-2">
                <p className="break-words">{t(d.key, d.values)}</p>
                <p className="text-sm text-[var(--text-2)]">
                  {formatDateTime(i.at, timeZone)}
                  {i.actor ? ` · ${i.actor.name}` : ` · ${t('feed.system')}`}
                </p>
              </li>
            );
          })}
        </ol>
      )}
      {failed && <p className="mt-2 text-[var(--danger)]">{t('feed.loadFailed')}</p>}
      {next && (
        <div className="mt-3">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => void load(group, next, true)}>
            {busy ? t('form.loading') : t('feed.more')}
          </Button>
        </div>
      )}
    </Card>
  );
}
