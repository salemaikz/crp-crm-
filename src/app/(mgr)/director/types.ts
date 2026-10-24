// Формы данных панели директора. Клиентским компонентам нельзя импортировать src/server/**; page.tsx присваивает
// им форму из домена, и расхождение ловит typecheck.
import type { FunnelRow, Period, Rate, ReasonRow, ReportLabels, RevenueRow } from '../reports/types';

export type { FunnelRow, Period, Rate, ReportLabels, RevenueRow };

export type DirectorData = {
  generatedAt: number;
  /** Показанная неделя: текущая или прошлая целиком. */
  weekKey: 'current' | 'prev';
  /** Топ-5 причин колонки «мусор» доски; null — такой колонки в настройках нет. */
  reasons: { key: string; label: string | null; total: number; top: ReasonRow[] } | null;
  week: Period;
  prevWeek: Period;
  calls: { outcomes: number; connects: number; prevOutcomes: number; prevConnects: number };
  eventLabels: { group: string; individual: string };
  bookings: { groups: number; consults: number };
  /** `unmarked` — дата записи прошла, явка не отмечена (в «из отмеченных» не входят). */
  attendance: { attended: number; noShow: number; rate: Rate; unmarked: number };
  conversion: { average: Rate; team: Rate; operators: number; minConnects: number };
  /** `withoutBooking` — покупки недели без записи на мероприятие: в «Покупках» есть, в цепочке «запись → явка» нет. */
  purchases: { count: number; sumKzt: number; prevCount: number; prevSumKzt: number; withoutBooking: number };
  funnel: FunnelRow;
  revenue: RevenueRow[];
  stock: { poolReady: number; capacityPerDay: number; days: number | null };
};

export type DirectorProps = {
  initial: DirectorData;
  labels: ReportLabels;
  /** Кнопка выгрузки CSV — при `report.export`. */
  canExport: boolean;
};
