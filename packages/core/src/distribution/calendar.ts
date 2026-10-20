// Адаптер рабочего календаря установки (`core/time`) к узкому интерфейсу раздачи.
import { toLocalTime, type WorkCalendar } from '../time';
import type { DistributionCalendar } from './types';

/** `DistributionCalendar` поверх `createWorkCalendar`: сутки, минуты от полуночи, рабочие дни. */
export function toDistributionCalendar(
  cal: Pick<WorkCalendar, 'timezone' | 'localDay' | 'isWorkday' | 'nextWorkday'>,
): DistributionCalendar {
  return {
    localDay: (at) => cal.localDay(at),
    localMinutes(at) {
      const p = toLocalTime(at, cal.timezone);
      return p.hour * 60 + p.minute;
    },
    isWorkday: (day) => cal.isWorkday(day),
    nextWorkday: (day) => cal.nextWorkday(day),
  };
}
