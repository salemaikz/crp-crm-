// Границы просрочки перезвона для одного «сейчас» (pipeline-v2 §4.3): считаются один раз и уходят в SQL параметрами.
// Оболочка над ядром: тревоги и сводки знают о календаре только `localDay`, а `dueBounds` ядра больше ничего не читает.
import { calling, type time } from '@crm/core';

export function dueBoundsAt(now: number, toleranceMin: number, calendar: Pick<time.WorkCalendar, 'localDay'>): calling.DueBounds {
  return calling.dueBounds(now, toleranceMin, calendar as unknown as calling.WorkCalendar);
}
