// Подпись вида мероприятия для узкой колонки: короткая из настроек, полная — в подсказку (title).
import type { ReportLabels } from './types';

export function eventTypeShortOf(labels: Pick<ReportLabels, 'eventTypes' | 'eventTypeShorts'>, key: string): { short: string; full: string } {
  const full = labels.eventTypes[key] ?? key;
  return { short: labels.eventTypeShorts?.[key] ?? full, full };
}
