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
  /** Конверсии цепочки (D-344): записи / дозвоны, явка (пришли) / записи, покупки / явка. Нулевой знаменатель — null. */
  bookedPerConnect: Rate;
  attendedPerBooked: Rate;
  purchasedPerAttended: Rate;
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

/** Три конверсии цепочки без остальных счётчиков. */
export interface OperatorConversions {
  bookedPerConnect: Rate;
  attendedPerBooked: Rate;
  purchasedPerAttended: Rate;
}

/**
 * Средняя по операторам (D-343): среднее арифметическое конверсий операторов, у которых за период не меньше
 * `minConnects` дозвонов. Это не конверсия команды (отношение сумм): она — в `totals`. Операторов нет — все null.
 */
export interface OperatorsAverage extends OperatorConversions {
  /** Сколько операторов вошло в среднюю. */
  operators: number;
  minConnects: number;
}

export interface OperatorsReport {
  period: ResolvedPeriod;
  grouping: Grouping;
  callsPerHourTarget: number | null;
  rows: OperatorPeriodRow[];
  /** Итого по команде: счётчики и конверсии отношением сумм. */
  totals: OperatorMetrics;
  average: OperatorsAverage;
}

// ---------------------------------------------------------------------------
// Воронка команды
// ---------------------------------------------------------------------------

export const FUNNEL_STEPS = ['issued', 'connected', 'lpr', 'booked', 'attended', 'purchased'] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];
export type FunnelCounts = Record<FunnelStep, number>;

/** Вид записи для разбивки шагов «запись» и «явка» (D-344); подписи берёт интерфейс из booking.eventTypes. */
export const FUNNEL_KINDS = ['group', 'individual'] as const;
export type FunnelKind = (typeof FUNNEL_KINDS)[number];
export type FunnelKindCounts = Record<FunnelKind, { booked: number; attended: number }>;
/** Конверсии по видам: запись к ЛПР, явка к записи того же вида. */
export type FunnelKindRates = Record<FunnelKind, { booked: Rate; attended: Rate }>;

export interface FunnelRow {
  /** userId (by=operator) или ключ источника (by=source: source_key, иначе source_kind). */
  key: string;
  /** Имя сотрудника; для источника — null (подпись строит интерфейс из настроек). */
  name: string | null;
  counts: FunnelCounts;
  /** Конверсия шага к предыдущему; у `issued` — null. */
  rates: Record<FunnelStep, Rate>;
  /** Те же шаги «запись» и «явка» по видам; сумма видов = `counts.booked` / `counts.attended`. */
  kinds: FunnelKindCounts;
  kindRates: FunnelKindRates;
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

export const ATTENDANCE_LIST_STATUSES = ['attended', 'no_show', 'unmarked', 'planned', 'cancelled'] as const;
/** «Не отмечено» — дата прошла, явка не отмечена; «planned» — запись ещё впереди. */
export type AttendanceListStatus = (typeof ATTENDANCE_LIST_STATUSES)[number];

export const ATTENDANCE_LIST_PAGE = 50;

/** Строка поимённого списка явки (D-344). Содержит название клиента — оператору вид закрыт (403). */
export interface AttendanceListRow {
  bookingId: string;
  /** Местная дата и время встречи. */
  date: string;
  startTime: string;
  eventTypeKey: string;
  clientId: string;
  clientName: string;
  bookedByUserId: string | null;
  bookedByName: string | null;
  status: AttendanceListStatus;
  /** Кто отметил явку: null — не отмечена или отмечена системой. */
  markedByUserId: string | null;
  markedByName: string | null;
  consultantUserId: string | null;
  consultantName: string | null;
  /** Выигранная сделка той же записи: сумма в тенге; null — покупки нет. */
  purchaseSumKzt: number | null;
}

export interface AttendanceListReport {
  period: ResolvedPeriod;
  rows: AttendanceListRow[];
  /** Курсор следующей страницы; null — конец списка. */
  next: string | null;
  /** Записей по статусам при тех же фильтрах, кроме статуса (чипы над таблицей); null — страница не первая. */
  counts: Record<AttendanceListStatus, number> | null;
}

// ---------------------------------------------------------------------------
// Причины
// ---------------------------------------------------------------------------

export const REASON_GROUPS = ['callback', 'written_off', 'not_interested', 'not_target', 'do_not_call', 'deal_lost', 'no_show'] as const;
export type ReasonGroup = (typeof REASON_GROUPS)[number];

export interface ReasonRow {
  /**
   * Группа: `outcome_kind` итога (callback, not_interested, not_target, do_not_call), written_off (списанные карточки:
   * ручное и системное), deal_lost или no_show (неявки; код — вид мероприятия, `event_type_key`).
   */
  group: ReasonGroup;
  /** Пустая строка — «без причины» (старый контракт «Перезвонить»). */
  reasonCode: string;
  count: number;
  /** Доля внутри группы. */
  share: Rate;
}

/** Блок отчёта «Причины» — колонка доски роли `trash` или `callback`; доли — от итога блока, а не группы. */
export interface ReasonBlock {
  /** Ключ колонки доски пресета. */
  key: string;
  /** Подпись колонки из пресета; null — пресет доски не задан (интерфейс берёт подпись состояния из локали). */
  label: string | null;
  role: 'trash' | 'callback';
  total: number;
  rows: ReasonRow[];
}

export interface ReasonsReport {
  period: ResolvedPeriod;
  /** Прежние группы («Подробно»): доля внутри группы. */
  rows: ReasonRow[];
  /** Блоки по колонкам доски (A4); пусто, если колонок этих ролей нет. */
  blocks: ReasonBlock[];
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
  | { key: 'attendance'; period: PeriodInput; filters: ReportFilters; by: 'event_type' | 'consultant' | 'author'; view?: 'summary' }
  | { key: 'attendance'; view: 'list'; period: PeriodInput; filters: ReportFilters; list: AttendanceListFilters }
  | { key: 'reasons'; period: PeriodInput; filters: ReportFilters };

/** Фильтры и страница списка явки (кроме общих: период, сотрудник — автор записи, источник). */
export interface AttendanceListFilters {
  eventType: string | null;
  status: AttendanceListStatus | null;
  /** Консультант (userId). */
  consultant: string | null;
  /** Курсор предыдущей страницы; null — первая. */
  cursor: string | null;
  /** Размер страницы; выгрузка берёт большие страницы. */
  limit: number;
}

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

/** Результат по запросу: список явки — отдельная форма, остальное — по ключу отчёта. */
export type ReportResult<Q extends ReportQuery> = Q extends { key: 'attendance'; view: 'list' } ? AttendanceListReport : ReportOf<Q['key']>;

/** Один вход для страницы, API и выгрузки. Нет охвата пространства у `report.view` — ForbiddenError (раздел). */
export type GetReport = <Q extends ReportQuery>(viewer: Viewer, q: Q) => Promise<ReportResult<Q>>;

// ---------------------------------------------------------------------------
// Панель директора (R4)
// ---------------------------------------------------------------------------

export interface DirectorReasons {
  key: string;
  label: string | null;
  total: number;
  top: ReasonRow[];
}

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
  attendance: { attended: number; noShow: number; rate: Rate; unmarked: number };
  /** «Средняя конверсия операторов» (D-343): среднее «записи / дозвоны» по операторам с ≥ `minConnects` дозвонов за неделю. */
  conversion: { average: Rate; team: Rate; operators: number; minConnects: number };
  /** `withoutBooking` — покупки недели без записи на мероприятие: в «Покупках» есть, в цепочке «запись → явка» нет. */
  purchases: { count: number; sumKzt: number; prevCount: number; prevSumKzt: number; withoutBooking: number };
  funnel: FunnelRow;
  revenue: RevenueRow[];
  /** Какая неделя показана: текущая или прошлая целиком (`?week=prev`). */
  weekKey: DirectorWeek;
  /**
   * Топ-5 причин двух колонок доски за показанную неделю: роль «мусор» и роль «перезвон» (подписи — из пресета);
   * доля — от итога колонки. Перезвон считает итоги `callback` и выходы № 33 с кодом причины (D-355); null — колонки
   * такой роли в пресете нет.
   */
  reasons: { trash: DirectorReasons | null; callback: DirectorReasons | null };
  /** «В пуле»: готово к раздаче. Запас в днях не показываем (требование руководителя, круг 3). */
  stock: { poolReady: number };
}

export const DIRECTOR_WEEKS = ['current', 'prev'] as const;
export type DirectorWeek = (typeof DIRECTOR_WEEKS)[number];

export type GetDirectorDashboard = (viewer: Viewer, opts?: { week?: DirectorWeek }) => Promise<DirectorDashboard>;

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
export type ToExportTable = <K extends ReportKey>(key: K, report: ReportOf<K> | AttendanceListReport, t: (key: string, values?: Record<string, string | number>) => string) => ExportTable;

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
