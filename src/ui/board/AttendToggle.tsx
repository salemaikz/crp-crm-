'use client';

// Тумблер «Был на …» (pipeline-v2 §5.2): показывает признак, а у того, кто вправе отмечать явку, нажатие отмечает
// «пришёл» по записи этого вида. Цвет — не единственный носитель смысла: у включённого есть галочка и слово «Был».
import { Check, Circle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ToggleView } from './attend';

export function AttendToggle({ view, event, busy, onToggle }: { view: ToggleView; event: string; busy?: boolean; onToggle: () => void }) {
  const t = useTranslations('board');
  const label = t(`badge.${view.kind}`, { event: event || t('chip.eventUnknown') });
  const hint = view.hint ? t(`toggle.hint.${view.hint}`, { event: event || t('chip.eventUnknown') }) : '';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={view.on}
      aria-label={view.interactive ? t('toggle.mark', { event: event || t('chip.eventUnknown') }) : label}
      title={hint || undefined}
      disabled={!view.interactive || busy}
      onClick={onToggle}
      className="k-chip relative z-10"
      data-no-drag
      data-testid={`tile-toggle-${view.kind}`}
      data-on={view.on ? '1' : '0'}
      data-interactive={view.interactive ? '1' : '0'}
      style={view.on ? { background: 'var(--success-tint)', borderColor: 'var(--success)', color: 'var(--text)' } : undefined}
    >
      {view.on ? <Check size={14} aria-hidden="true" /> : <Circle size={14} aria-hidden="true" />}
      <span>{label}</span>
    </button>
  );
}
