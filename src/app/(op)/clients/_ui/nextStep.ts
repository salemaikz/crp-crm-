import type { ClientSummaryDto } from '@/server/domain/clients';
import { formatDateTime, formatDue } from './format';

type Tr = (key: string, values?: Record<string, string | number>) => string;

/** Фраза «Следующий шаг: …» (локаль `clients.summary.next.*`): срок «на день» — без времени, «в течение дня». */
export function nextStepText(t: Tr, next: ClientSummaryDto['nextStep'], timeZone: string): string {
  if (next.at === null) return t(`summary.next.${next.kind === 'task' ? 'taskNoDate' : next.kind}`);
  const date = next.precision === 'day' ? `${formatDue(next.at, 'day', timeZone)}, ${t('summary.inDay')}` : formatDateTime(next.at, timeZone);
  return t(`summary.next.${next.kind}`, { date });
}
