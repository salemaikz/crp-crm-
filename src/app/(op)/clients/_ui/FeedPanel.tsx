'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button, Card, Chip, ChipGroup, EmptyState, useToast } from '@/ui/kit';
import { FeedMessages } from '@/ui/messenger/FeedMessages';
import { foldMessages } from '@/ui/messenger/fold';
import { useFeedControl } from './ClientsProviders';
import { describeEvent, makeContext } from './feedLabels';
import { formatDateTime } from './format';
import { send } from './requests';
import type { FeedItemView, FeedLabels } from './types';

const GROUPS = ['calls', 'messages', 'bookings', 'deals', 'tasks', 'notes', 'system'] as const;

type Props = {
  clientId: string;
  canPin?: boolean;
  initialItems: FeedItemView[];
  initialNext: string | null;
  timeZone: string;
  labels: FeedLabels;
};

type Page = { items: FeedItemView[]; next: string | null };

export function FeedPanel({ clientId, canPin = false, initialItems, initialNext, timeZone, labels }: Props) {
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
  const router = useRouter();
  const toast = useToast();
  const control = useFeedControl();
  // group: одна из групп ленты или 'edits' («История правок»)
  const [group, setGroup] = useState<string | null>(null);
  const [items, setItems] = useState(initialItems);
  const [next, setNext] = useState(initialNext);
  const [showSystem, setShowSystem] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function load(g: string | null, cursor: string | null, append: boolean, deal: string | null = control.dealId) {
    setBusy(true);
    setFailed(false);
    try {
      const q = new URLSearchParams();
      if (g === 'edits') q.set('group', 'edits');
      else if (g) q.set('groups', g);
      if (deal) q.set('dealId', deal);
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

  // Лента сделки и обновление после новой заметки: первый показ уже пришёл с сервера, его не повторяем
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void load(group, null, false, control.dealId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- перезагрузка только по сделке и счётчику обновления
  }, [control.dealId, control.rev]);

  async function togglePin(noteId: string, pinned: boolean) {
    const { result, data } = await send('PATCH', `/api/clients/notes/${noteId}`, { pinned });
    if (result.ok) {
      setItems((cur) => cur.map((i) => (i.note?.id === noteId ? { ...i, note: { ...i.note, pinned } } : i)));
      control.reload();
      router.refresh();
      return;
    }
    const detail = (data as { detail?: string } | null)?.detail;
    toast.show({ message: detail === 'pin_limit' ? t('notes.pin_limit') : t(`form.failure.${result.kind === 'fields' ? 'invalid' : result.kind}`), tone: 'danger' });
  }

  function choose(g: string | null) {
    setGroup(g);
    setShowSystem(false);
    void load(g, null, false);
  }

  // Системные события свёрнуты в одну строку, пока не выбрана группа «Система» или не раскрыты
  const system = items.filter((i) => i.group === 'system');
  const collapse = group !== 'system' && group !== 'edits' && !showSystem && system.length > 0;
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
        <Chip active={group === 'edits'} onClick={() => choose('edits')}>
          {t('feed.filter.edits')}
        </Chip>
      </ChipGroup>
      {control.dealId && (
        <p className="mb-2 flex flex-wrap items-center gap-2 text-sm">
          <span>{t('feed.filter.deal')}</span>
          <Button variant="quiet" size="sm" onClick={() => control.setDealId(null)}>
            {t('feed.filter.dealOff')}
          </Button>
        </p>
      )}
      {collapse && (
        <Button variant="quiet" size="sm" className="mb-2" onClick={() => setShowSystem(true)}>
          {t('feed.systemCollapsed', { count: system.length })}
        </Button>
      )}
      {visible.length === 0 ? (
        <EmptyState framed={false} headingLevel="h3" title={t('feed.emptyTitle')} description={t('feed.emptyText')} />
      ) : (
        <ol className="flex flex-col divide-y divide-[var(--border)]">
          {foldMessages(visible, timeZone).map((entry) => {
            if (entry.kind === 'messages') {
              return (
                <li key={entry.key} className="py-2">
                  <FeedMessages items={entry.items} formatTime={(at) => formatDateTime(at, timeZone)} />
                </li>
              );
            }
            const i = entry.item;
            const d = describeEvent(i, context);
            return (
              <li key={i.id} className="py-2">
                <p className="break-words">{t(d.key, d.values)}</p>
                {i.note && (
                  <div className="mt-1">
                    <p className="break-words whitespace-pre-wrap" data-testid="feed-note">
                      {i.note.body}
                    </p>
                    {canPin && (
                      <Button variant="quiet" size="sm" onClick={() => void togglePin(i.note!.id, !i.note!.pinned)}>
                        {i.note.pinned ? t('notes.unpin') : t('notes.pin')}
                      </Button>
                    )}
                  </div>
                )}
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
