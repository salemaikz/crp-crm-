'use client';

// Шторка лида (pipeline-v2 §9.6): нажали на плитку — сверху главное, ниже поля, значение поля — кнопка, правится на месте
// (сохраняется одно поле, компонент CardFieldRow из экрана «Звонить»). Данные читаются при открытии и нигде не хранятся.
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { CardFieldRow } from '@/ui/call/CardFieldRow';
import { Button, BottomSheet } from '@/ui/kit';
import { AttendToggle } from './AttendToggle';
import { toggleViews, type AttendKind } from './attend';
import { drawerRows, type DrawerRow } from './drawerFields';
import type { BoardCardDto, BoardConfig } from './types';

export function LeadDrawer({
  card,
  inlineEdit,
  columnTitle,
  fetchFn,
  onClose,
  attend,
  attendLabels,
  now,
  attendBusy,
  onAttend,
}: {
  card: BoardCardDto;
  inlineEdit: boolean;
  columnTitle: string;
  fetchFn: typeof fetch;
  onClose: () => void;
  attend: Pick<BoardConfig, 'canAttend' | 'eventBehaviors'>;
  attendLabels: BoardConfig['attendLabels'];
  now: number;
  attendBusy: boolean;
  onAttend: (card: BoardCardDto, kind: AttendKind) => void;
}) {
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
        {/* Тумблеры явки: оба вида; нет записи или права — погашены с подсказкой (§5.2) */}
        <div className="flex flex-col gap-1" data-testid="drawer-toggles">
          <div className="flex flex-wrap gap-2">
            {toggleViews(card, attend, now, true).map((v) => (
              <AttendToggle key={v.kind} view={v} event={attendLabels[v.kind]} busy={attendBusy} onToggle={() => onAttend(card, v.kind)} />
            ))}
          </div>
          {toggleViews(card, attend, now, true).some((v) => !v.interactive && v.hint === 'noRight') && (
            <p className="text-xs" style={{ color: 'var(--text-3)' }} data-testid="drawer-toggle-hint">
              {t('toggle.hint.noRight', { event: '' })}
            </p>
          )}
        </div>
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
