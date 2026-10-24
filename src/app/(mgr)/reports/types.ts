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
  bookedPerConnect: Rate;
  attendedPerBooked: Rate;
  purchasedPerAttended: Rate;
  purchases: number;
  purchaseSumKzt: number;
  skips: number;
  workedHours: number;
  callsPerHour: number | null;
};
export type OperatorPeriodRow = OperatorMetrics & { userId: string; name: string; bucket: string; belowTarget: boolean };
export type OperatorsAverage = { operators: number; minConnects: number; bookedPerConnect: Rate; attendedPerBooked: Rate; purchasedPerAttended: Rate };
export type OperatorsData = {
  period: Period;
  grouping: Grouping;
  callsPerHourTarget: number | null;
  rows: OperatorPeriodRow[];
  totals: OperatorMetrics;
  average: OperatorsAverage;
};

export const FUNNEL_STEPS = ['issued', 'connected', 'lpr', 'booked', 'attended', 'purchased'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export const FUNNEL_KINDS = ['group', 'individual'] as const;
export type FunnelKind = (typeof FUNNEL_KINDS)[number];
export type FunnelRow = {
  key: string;
  name: string | null;
  counts: Record<FunnelStep, number>;
  rates: Record<FunnelStep, Rate>;
  kinds: Record<FunnelKind, { booked: number; attended: number }>;
  kindRates: Record<FunnelKind, { booked: Rate; attended: Rate }>;
};
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

export const ATTENDANCE_LIST_STATUSES = ['attended', 'no_show', 'unmarked', 'planned', 'cancelled'] as const;
export type AttendanceListStatus = (typeof ATTENDANCE_LIST_STATUSES)[number];
export type AttendanceView = 'summary' | 'list';

export type AttendanceListRow = {
  bookingId: string;
  date: string;
  startTime: string;
  eventTypeKey: string;
  clientId: string;
  clientName: string;
  bookedByUserId: string | null;
  bookedByName: string | null;
  status: AttendanceListStatus;
  markedByUserId: string | null;
  markedByName: string | null;
  consultantUserId: string | null;
  consultantName: string | null;
  purchaseSumKzt: number | null;
};
export type AttendanceListData = { period: Period; rows: AttendanceListRow[]; next: string | null };

export const REASON_GROUPS = ['callback', 'written_off', 'not_interested', 'not_target', 'do_not_call', 'deal_lost', 'no_show'] as const;
export type ReasonGroup = (typeof REASON_GROUPS)[number];
export type ReasonRow = { group: ReasonGroup; reasonCode: string; count: number; share: Rate };
/** Блок по колонке доски (роль «мусор» или «перезвон»); доли — от итога блока. */
export type ReasonBlock = { key: string; label: string | null; role: 'trash' | 'callback'; total: number; rows: ReasonRow[] };
export type ReasonsData = { period: Period; rows: ReasonRow[]; blocks: ReasonBlock[] };

export type ReportData = OperatorsData | FunnelData | RevenueData | AttendanceData | AttendanceListData | ReasonsData;

export type ReportLabels = {
  sources: Record<string, string>;
  serviceTypes: Record<string, string>;
  eventTypes: Record<string, string>;
  reasons: Record<string, Record<string, string>>;
  /** Короткие подписи видов записи: group, individual. */
  eventKinds: Record<string, string>;
};

export type ReportMeta = {
  today: string;
  timeZone: string;
  labels: ReportLabels;
  staff: { userId: string; name: string }[];
  consultants: { userId: string; name: string }[];
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
  /** Явка: сводка или поимённый список (фильтры списка ниже). */
  attendanceView: AttendanceView;
  listEventType: string;
  listStatus: '' | AttendanceListStatus;
  listConsultant: string;
};

export type InitialReport = { data: ReportData | null; error: 'period_invalid' | 'invalid' | 'generic' | null };

/** Что можно выгрузить с экрана (R3b): считает страница по правам и флагу, сервер проверяет ещё раз. */
export type ExportActions = {
  /** CSV и XLSX отчёта — `report.export`; XLSX — ещё и FEATURE_REPORTS_EXPORT. */
  csv: boolean;
  xlsx: boolean;
  /** Полная выгрузка — `data.export_all`. */
  full: boolean;
  /** Журнал выгрузок — администратор или `export.journal`. */
  journal: boolean;
  /** Полных выгрузок в сутки на сотрудника. */
  fullLimit: number;
};
