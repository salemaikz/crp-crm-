'use client';

// Тумблер «Был на …» (pipeline-v2 §5.2): показывает признак, а у того, кто вправе отмечать явку, нажатие отмечает
// «пришёл» по записи этого вида. Цвет — не единственный носитель смысла: у включённого есть галочка и слово «Был».
import { Check, Circle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ToggleView } from './attend';

/** `compact` (доска РОП): «{short} ✓» / «{short} ○» по короткой подписи вида, 28 px; полная фраза остаётся в aria-label и title. */
export function AttendToggle({ view, event, busy, onToggle, compact }: { view: ToggleView; event: string; busy?: boolean; onToggle: () => void; compact?: boolean }) {
  const t = useTranslations('board');
  const label = t(`badge.${view.kind}`, { event: event || t('chip.eventUnknown') });
  const hint = view.hint ? t(`toggle.hint.${view.hint}`, { event: event || t('chip.eventUnknown') }) : '';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={view.on}
      aria-label={view.interactive ? t('toggle.mark', { event: event || t('chip.eventUnknown') }) : label}
      title={hint || (compact ? label : undefined)}
      disabled={!view.interactive || busy}
      onClick={onToggle}
      className={compact ? 'k-chip relative z-10 min-h-7 shrink-0 gap-1 px-2 py-0 text-xs whitespace-nowrap' : 'k-chip relative z-10 min-h-9 py-1 text-sm'}
      data-no-drag
      data-testid={`tile-toggle-${view.kind}`}
      data-on={view.on ? '1' : '0'}
      data-interactive={view.interactive ? '1' : '0'}
      style={view.on ? { background: 'var(--success-tint)', borderColor: 'var(--success)', color: 'var(--text)' } : undefined}
    >
      {compact ? (
        <>
          <span>{event || t('chip.eventUnknown')}</span>
          {view.on ? <Check size={12} aria-hidden="true" /> : <Circle size={12} aria-hidden="true" />}
        </>
      ) : (
        <>
          {view.on ? <Check size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}
          <span>{label}</span>
        </>
      )}
    </button>
  );
}
