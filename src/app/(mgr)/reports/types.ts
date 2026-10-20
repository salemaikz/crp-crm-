// Формы данных экрана отчётов. Клиентским компонентам нельзя импортировать src/server/**, поэтому типы ответа API
// описаны здесь; page.tsx присваивает им форму из домена, и расхождение ловит typecheck.
export type ReportKey = 'operators' | 'funnel' | 'revenue' | 'attendance' | 'reasons';
export const REPORT_KEYS: readonly ReportKey[] = ['operators', 'funnel', 'revenue', 'attendance', 'reasons'];

export type Grouping = 'total' | 'day' | 'week';
export type FunnelBy = 'operator' | 'source';
export type AttendanceBy = 'event_type' | 'consultant' | 'author';
export type Rate = number | null;

export type Period = { from: string; to: string; fromMs: number; toMs: number; timeZone: string; days: number };

export type OperatorMetrics = {
  issued: number;
  outcomes: number;
  connects: number;
  lpr: number;
  groups: number;
  consults: number;
  attended: number;
  noShow: number;
  attendanceRate: Rate;
  purchases: number;
  purchaseSumKzt: number;
  skips: number;
  workedHours: number;
  callsPerHour: number | null;
};
export type OperatorPeriodRow = OperatorMetrics & { userId: string; name: string; bucket: string; belowTarget: boolean };
export type OperatorsData = { period: Period; grouping: Grouping; callsPerHourTarget: number | null; rows: OperatorPeriodRow[]; totals: OperatorMetrics };

export const FUNNEL_STEPS = ['issued', 'connected', 'lpr', 'booked', 'attended', 'purchased'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export type FunnelRow = { key: string; name: string | null; counts: Record<FunnelStep, number>; rates: Record<FunnelStep, Rate> };
export type FunnelData = { period: Period; by: FunnelBy; rows: FunnelRow[]; total: FunnelRow };

export type RevenueRow = {
  serviceTypeKey: string;
  purchases: number;
  sumKzt: number;
  firstPurchases: number;
  firstSumKzt: number;
  repeatPurchases: number;
  repeatSumKzt: number;
};
export type RevenueData = { period: Period; rows: RevenueRow[]; total: Omit<RevenueRow, 'serviceTypeKey'> };

export type AttendanceRow = {
  key: string;
  name: string | null;
  booked: number;
  attended: number;
  noShow: number;
  unmarked: number;
  cancelled: number;
  rate: Rate;
  purchases: number;
};
export type AttendanceData = { period: Period; by: AttendanceBy; rows: AttendanceRow[]; total: Omit<AttendanceRow, 'key' | 'name'> };

export type ReasonRow = { group: 'not_interested' | 'not_target' | 'do_not_call' | 'deal_lost'; reasonCode: string; count: number; share: Rate };
export type ReasonsData = { period: Period; rows: ReasonRow[] };

export type ReportData = OperatorsData | FunnelData | RevenueData | AttendanceData | ReasonsData;

export type ReportLabels = {
  sources: Record<string, string>;
  serviceTypes: Record<string, string>;
  eventTypes: Record<string, string>;
  reasons: Record<string, Record<string, string>>;
};

export type ReportMeta = {
  today: string;
  timeZone: string;
  labels: ReportLabels;
  staff: { userId: string; name: string }[];
};

/** Что выбрано на экране (то же, что в адресе страницы). */
export type ReportQueryState = {
  key: ReportKey;
  from: string;
  to: string;
  users: string[];
  source: string;
  group: Grouping;
  funnelBy: FunnelBy;
  attendanceBy: AttendanceBy;
};

export type InitialReport = { data: ReportData | null; error: 'period_invalid' | 'invalid' | 'generic' | null };
