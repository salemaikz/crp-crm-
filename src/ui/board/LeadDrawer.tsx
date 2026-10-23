'use client';

// Шторка лида (pipeline-v2 §9.6): нажали на плитку — сверху главное, ниже поля, значение поля — кнопка, правится на месте
// (сохраняется одно поле, компонент CardFieldRow из экрана «Звонить»). Данные читаются при открытии и нигде не хранятся.
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { CardFieldRow } from '@/ui/call/CardFieldRow';
import { Button, BottomSheet } from '@/ui/kit';
import { drawerRows, type DrawerRow } from './drawerFields';
import type { BoardCardDto } from './types';

export function LeadDrawer({ card, inlineEdit, columnTitle, fetchFn, onClose }: { card: BoardCardDto; inlineEdit: boolean; columnTitle: string; fetchFn: typeof fetch; onClose: () => void }) {
  const t = useTranslations('board');
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [rows, setRows] = useState<DrawerRow[]>([]);
  const [saved, setSaved] = useState<Record<string, unknown>>({});

  useEffect(() => {
    const ctl = new AbortController();
    void (async () => {
      try {
        const res = await fetchFn(`/api/clients/${encodeURIComponent(card.clientId)}`, { cache: 'no-store', credentials: 'same-origin', signal: ctl.signal });
        if (!res.ok) return setPhase('error');
        setRows(drawerRows(await res.json(), inlineEdit));
        setPhase('ready');
      } catch {
        if (!ctl.signal.aborted) setPhase('error');
      }
    })();
    return () => ctl.abort();
  }, [card.clientId, inlineEdit, fetchFn]);

  return (
    <BottomSheet
      open
      onClose={onClose}
      closeLabel={t('sheet.close')}
      title={card.name}
      description={[columnTitle, card.lprName !== '' ? t('lpr', { name: card.lprName }) : '', card.phone?.masked ?? ''].filter((x) => x !== '').join(' · ')}
      footer={
        <Button href={`/clients/${card.clientId}`} size="lg" block data-testid="drawer-open-card">
          {t('drawer.openCard')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3" data-testid="lead-drawer">
        {phase === 'loading' && (
          <p role="status" style={{ color: 'var(--text-2)' }}>
            {t('drawer.loading')}
          </p>
        )}
        {phase === 'error' && (
          <p role="alert" style={{ color: 'var(--danger)' }}>
            {t('drawer.error')}
          </p>
        )}
        {phase === 'ready' && rows.length === 0 && <p style={{ color: 'var(--text-2)' }}>{t('drawer.noFields')}</p>}
        {phase === 'ready' && rows.length > 0 && (
          <dl className="text-sm" data-testid="drawer-fields">
            {rows.map(({ field, value }) => (
              <CardFieldRow
                fetchFn={fetchFn}
                key={`${field.object}-${field.key}`}
                field={field}
                value={Object.hasOwn(saved, `${field.object}-${field.key}`) ? saved[`${field.object}-${field.key}`] : value}
                cardId={card.id}
                clientId={card.clientId}
                onValue={(key, v) => setSaved((s) => ({ ...s, [`${field.object}-${key}`]: v }))}
              />
            ))}
          </dl>
        )}
      </div>
    </BottomSheet>
  );
}
