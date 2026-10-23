// Отчёты за период, выгрузки и панель директора (R3a, R3b, R4): СИГНАТУРЫ. Дизайн — docs/reports-plugins-design.md
// §1–§4, решения D-261…D-265. Меняются только через architect. Тела — builder: period.ts, definitions.ts (чистые),
// periodRepo.ts (SQL), operators.ts, funnel.ts, revenue.ts, attendance.ts, reasons.ts, director.ts, exportTable.ts,
// exportLog.ts, fullExport.ts, fullExportRepo.ts, tickets.ts.
//
// Правила:
// - только счётчики, суммы в целых тенге, id и имена сотрудников; названий клиентов и номеров в отчётах нет
//   (кроме полной выгрузки, она — отдельный путь);
// - каждый запрос к данным клиентов — через scopeSql; отчёты за период требуют охват пространства (`report.view` ≥ space);
// - подписи (этапы, причины, типы услуг, источники) строит интерфейс по ключам; сервер отдаёт ключи.
import type { Viewer } from '@/server/access';

export const REPORT_KEYS = ['operators', 'funnel', 'revenue', 'attendance', 'reasons'] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

/** Длина периода, местных дней включительно (D-261). */
export const MAX_PERIOD_DAYS = 92;

/** Период в местных днях установки, обе границы включительно ('YYYY-MM-DD'). */
export interface PeriodInput {
  from: string;
  to: string;
}

/** Период в epoch-мс: [fromMs, toMs) — от 00:00 `from` до 00:00 дня после `to` в поясе установки. */
export interface ResolvedPeriod extends PeriodInput {
  fromMs: number;
  toMs: number;
  timeZone: string;
  days: number;
}

export type Grouping = 'total' | 'day' | 'week';

/** Доля в процентах с одним знаком (12.5) или null при нулевом знаменателе. Одна функция на всё: definitions.ts. */
export type Rate = number | null;

// ---------------------------------------------------------------------------
// Операторы за период (PROCESS 10.2)
// ---------------------------------------------------------------------------

export interface OperatorMetrics {
  /** Выдачи, новые для оператора (assign_log kinds из capKinds, D-039), различных карточек. */
  issued: number;
  outcomes: number;
  connects: number;
  lpr: number;
  /** Записи — головы цепочек переноса, кроме отмены «ошибка оператора» (D-261). */
  groups: number;
  consults: number;
  /** Явка по записям автора, по дате встречи. */
  attended: number;
  noShow: number;
  attendanceRate: Rate;
  /** Покупки по записям автора: выигранные сделки, где автор первой записи сделки — этот сотрудник (D-261). */
  purchases: number;
  purchaseSumKzt: number;
  skips: number;
  /** Сумма по дням «часов в работе» (D-262). */
  workedHours: number;
  callsPerHour: number | null;
}

export interface OperatorPeriodRow extends OperatorMetrics {
  userId: string;
  name: string;
  /** 'total' или первый день корзины (день или понедельник недели). */
  bucket: string;
  /** Мягкая цель: ниже `reports.callsPerHourTarget`; без цвета и блокировок (D-262). */
  belowTarget: boolean;
}

export interface OperatorsReport {
  period: ResolvedPeriod;
  grouping: Grouping;
  callsPerHourTarget: number | null;
  rows: OperatorPeriodRow[];
  totals: OperatorMetrics;
}

// ---------------------------------------------------------------------------
// Воронка команды
// ---------------------------------------------------------------------------

export const FUNNEL_STEPS = ['issued', 'connected', 'lpr', 'booked', 'attended', 'purchased'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export type FunnelCounts = Record<FunnelStep, number>;

export interface FunnelRow {
  /** userId (by=operator) или ключ источника (by=source: source_key, иначе source_kind). */
  key: string;
  /** Имя сотрудника; для источника — null (подпись строит интерфейс из настроек). */
  name: string | null;
  counts: FunnelCounts;
  /** Конверсия шага к предыдущему; у `issued` — null. */
  rates: Record<FunnelStep, Rate>;
}

export interface FunnelReport {
  period: ResolvedPeriod;
  by: 'operator' | 'source';
  rows: FunnelRow[];
  total: FunnelRow;
}

// ---------------------------------------------------------------------------
// Выручка по типам услуг
// ---------------------------------------------------------------------------

export interface RevenueRow {
  serviceTypeKey: string;
  purchases: number;
  sumKzt: number;
  /** Первая покупка клиента (по won_at, id) — остальные «повторные» (PROCESS 4.3). */
  firstPurchases: number;
  firstSumKzt: number;
  repeatPurchases: number;
  repeatSumKzt: number;
}

export interface RevenueReport {
  period: ResolvedPeriod;
  rows: RevenueRow[];
  total: Omit<RevenueRow, 'serviceTypeKey'>;
}

// ---------------------------------------------------------------------------
// Записи и явка
// ---------------------------------------------------------------------------

export interface AttendanceRow {
  /** event_type_key | userId консультанта ('' — «серые») | userId автора. */
  key: string;
  name: string | null;
  /** Живые записи с датой встречи в периоде (registered, confirmed, attended, no_show). */
  booked: number;
  attended: number;
  noShow: number;
  /** Дата прошла, явка не отмечена. */
  unmarked: number;
  /** Отменены с датой встречи в периоде (кроме «ошибка оператора»). */
  cancelled: number;
  rate: Rate;
  /** Выигранные сделки за период, связанные с записями строки. */
  purchases: number;
}

export interface AttendanceReport {
  period: ResolvedPeriod;
  by: 'event_type' | 'consultant' | 'author';
  rows: AttendanceRow[];
  total: Omit<AttendanceRow, 'key' | 'name'>;
}

// ---------------------------------------------------------------------------
// Причины отказов
// ---------------------------------------------------------------------------

export interface ReasonRow {
  /** Группа справочника причин: outcome_kind итога или 'deal_lost'. */
  group: 'not_interested' | 'not_target' | 'do_not_call' | 'deal_lost';
  reasonCode: string;
  count: number;
  /** Доля внутри группы. */
  share: Rate;
}

export interface ReasonsReport {
  period: ResolvedPeriod;
  rows: ReasonRow[];
}

// ---------------------------------------------------------------------------
// Входы и сервисы
// ---------------------------------------------------------------------------

export interface ReportFilters {
  /** Только эти сотрудники (≤ 50); null — все. */
  userIds: string[] | null;
  /** Ключ источника; null — все. */
  sourceKey: string | null;
}

export type ReportQuery =
  | { key: 'operators'; period: PeriodInput; filters: ReportFilters; grouping: Grouping }
  | { key: 'funnel'; period: PeriodInput; filters: ReportFilters; by: 'operator' | 'source' }
  | { key: 'revenue'; period: PeriodInput; filters: ReportFilters }
  | { key: 'attendance'; period: PeriodInput; filters: ReportFilters; by: 'event_type' | 'consultant' | 'author' }
  | { key: 'reasons'; period: PeriodInput; filters: ReportFilters };

export type ReportOf<K extends ReportKey> = K extends 'operators'
  ? OperatorsReport
  : K extends 'funnel'
    ? FunnelReport
    : K extends 'revenue'
      ? RevenueReport
      : K extends 'attendance'
        ? AttendanceReport
        : ReasonsReport;

/** Разбор периода: 400 `period_invalid` (формат, from > to, длина > MAX_PERIOD_DAYS, будущее дальше завтра). */
export type ResolvePeriod = (input: PeriodInput, timeZone: string) => ResolvedPeriod;

/** Один вход для страницы, API и выгрузки. Нет охвата пространства у `report.view` — ForbiddenError (раздел). */
export type GetReport = <Q extends ReportQuery>(viewer: Viewer, q: Q) => Promise<ReportOf<Q['key']>>;

// ---------------------------------------------------------------------------
// Панель директора (R4)
// ---------------------------------------------------------------------------

export interface DirectorDashboard {
  generatedAt: number;
  /** Текущая неделя: понедельник … сегодня. */
  week: ResolvedPeriod;
  /** Прошлая неделя целиком — для сравнения числами, без графика. */
  prevWeek: ResolvedPeriod;
  calls: { outcomes: number; connects: number; prevOutcomes: number; prevConnects: number };
  /** Короткие подписи видов записи из настроек: первый групповой и первый индивидуальный; пусто — вида нет. */
  eventLabels: { group: string; individual: string };
  bookings: { groups: number; consults: number };
  attendance: { attended: number; noShow: number; rate: Rate };
  purchases: { count: number; sumKzt: number; prevCount: number; prevSumKzt: number };
  funnel: FunnelRow;
  revenue: RevenueRow[];
  /** Запас: готово в пуле и в рабочих днях (пул / (участники × лимит)); null — ёмкость 0. */
  stock: { poolReady: number; capacityPerDay: number; days: number | null };
}

export type GetDirectorDashboard = (viewer: Viewer) => Promise<DirectorDashboard>;

// ---------------------------------------------------------------------------
// Выгрузки (R3b)
// ---------------------------------------------------------------------------

export type ExportFormat = 'csv' | 'xlsx';

export interface ExportColumn {
  key: string;
  /** Заголовок из локали (строит маршрут через next-intl и передаёт сюда готовым). */
  label: string;
  type: 'text' | 'int' | 'money' | 'percent' | 'day';
}

export interface ExportTable {
  columns: ExportColumn[];
  rows: (string | number | null)[][];
}

/** Отчёт → таблица выгрузки. `t` — переводчик подписей (ключи и значения настроек), без Next в домене. */
export type ToExportTable = <K extends ReportKey>(key: K, report: ReportOf<K>, t: (key: string, values?: Record<string, string | number>) => string) => ExportTable;

/** Запись журнала выгрузок (audit_log `export.*`, PROCESS 8.6): без значений фильтров и ПДн. */
export interface ExportLogInput {
  kind: 'report' | 'full' | 'guests';
  reportKey: ReportKey | null;
  format: ExportFormat | 'zip';
  rows: number;
  /** Коды полей фильтра и группировки, без значений. */
  filterKeys: string[];
  periodDays: number | null;
}

export type WriteExportLog = (viewer: Viewer, input: ExportLogInput) => Promise<void>;

export interface ExportJournalRow {
  id: string;
  at: number;
  actorUserId: string | null;
  actorName: string | null;
  kind: ExportLogInput['kind'];
  reportKey: string | null;
  format: string;
  rows: number;
  filterKeys: string[];
  periodDays: number | null;
}

/** Журнал выгрузок: администратор или `export.journal`; 50 строк, курсор по (created_at, id). */
export type GetExportJournal = (viewer: Viewer, q: { before: { at: number; id: string } | null; limit: number }) => Promise<{ rows: ExportJournalRow[]; next: { at: number; id: string } | null }>;

/** Полная выгрузка, шаг 1 (D-264): пароль ещё раз → одноразовый билет на 60 с. Неверный пароль — 403 `password_invalid`. */
export interface FullExportTicket {
  ticket: string;
  expiresAt: number;
}
export type IssueFullExportTicket = (viewer: Viewer, input: { password: string }) => Promise<FullExportTicket>;

/** Шаг 2: билет гасится, журнал и уведомления пишутся до первого байта, ZIP отдаётся потоком. */
export type StreamFullExport = (viewer: Viewer, input: { ticket: string }) => Promise<{ filename: string; stream: ReadableStream<Uint8Array> }>;
