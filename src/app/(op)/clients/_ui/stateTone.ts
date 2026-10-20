// Состояние карточки → тон бейджа. Цвет не единственный носитель смысла: рядом значок и подпись (kit Badge).
import type { BadgeTone } from '@/ui/kit';

const TONES: Readonly<Record<string, BadgeTone>> = {
  new: 'info',
  retry: 'warning',
  callback: 'warning',
  agreed: 'success',
  client: 'success',
  not_interested: 'neutral',
  not_target: 'neutral',
  do_not_call: 'danger',
  written_off: 'neutral',
};

export function stateTone(state: string): BadgeTone {
  return TONES[state] ?? 'neutral';
}
