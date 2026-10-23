// Формы данных панели директора. Клиентским компонентам нельзя импортировать src/server/**; page.tsx присваивает
// им форму из домена, и расхождение ловит typecheck.
import type { FunnelRow, Period, Rate, ReportLabels, RevenueRow } from '../reports/types';

export type { FunnelRow, Period, Rate, ReportLabels, RevenueRow };

export type DirectorData = {
  generatedAt: number;
  week: Period;
  prevWeek: Period;
  calls: { outcomes: number; connects: number; prevOutcomes: number; prevConnects: number };
  eventLabels: { group: string; individual: string };
  bookings: { groups: number; consults: number };
  attendance: { attended: number; noShow: number; rate: Rate };
  conversion: { average: Rate; team: Rate; operators: number; minConnects: number };
  purchases: { count: number; sumKzt: number; prevCount: number; prevSumKzt: number };
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
