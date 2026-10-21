'use client';

import { useTranslations } from 'next-intl';
import { ActionBar, Badge, Button, type BadgeTone } from '@/ui/kit';
import type { GuestRow } from './types';

const TONE: Record<string, BadgeTone> = { registered: 'info', confirmed: 'success', attended: 'success', no_show: 'danger' };

interface Props {
  guest: GuestRow;
  started: boolean;
  busy: boolean;
  onMark: (g: GuestRow, to: 'attended' | 'no_show') => void;
}

/** Строка гостя: имя, контакт, хвост номера, кто записал, статус и кнопки отметки. */
export function GuestItem({ guest: g, started, busy, onMark }: Props) {
  const t = useTranslations('booking.duty');
  const ts = useTranslations('booking.status');
  const walkIn = g.via === 'walk_in';
  const title = walkIn ? t('walkInRow') : g.clientName;
  const meta = walkIn
    ? null
    : [g.contactName, g.phoneTail ? `…${g.phoneTail}` : '', g.bookedByName ? t('bookedBy', { name: g.bookedByName }) : ''].filter((x) => x !== '').join(' · ');
  const unmarked = g.status === 'registered' || g.status === 'confirmed';
  return (
    <li className="flex flex-col gap-2 border-b border-[var(--border)] py-3" data-testid="guest-row" data-status={g.status}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium break-words">{title}</div>
          {meta && <div className="text-sm text-[var(--text-2)] break-words">{meta}</div>}
        </div>
        <Badge tone={TONE[g.status] ?? 'neutral'}>{ts(g.status)}</Badge>
      </div>
      {/* «Пришёл / Не пришёл» — две равные половины строки; главная кнопка экрана одна, в липком футере */}
      <ActionBar equal={unmarked}>
        {unmarked && (
          <>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => onMark(g, 'attended')}>
              {t('attended')}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy || !started} onClick={() => onMark(g, 'no_show')}>
              {t('noShow')}
            </Button>
          </>
        )}
        {g.status === 'no_show' && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => onMark(g, 'attended')}>
            {t('fixAttended')}
          </Button>
        )}
        {g.status === 'attended' && (
          <Button variant="quiet" size="sm" disabled={busy || !started} onClick={() => onMark(g, 'no_show')}>
            {t('fixNoShow')}
          </Button>
        )}
      </ActionBar>
      {unmarked && !started && <span className="text-xs text-[var(--text-2)]">{t('notStarted')}</span>}
    </li>
  );
}
