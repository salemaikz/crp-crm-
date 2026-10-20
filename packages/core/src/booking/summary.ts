/**
 * Недельный отчёт по записям и явке: по мероприятию, по консультанту и по сотруднику
 * («кто кого записал») и его CSV.
 *
 * Источник: SalemAI 108fb70 src/lib/crm/booking/summary.ts — только чистые функции. Отличия:
 *   • вид записи — ключ из настроек (`eventTypeKey`) и поведение (`behavior`), а не br/bk;
 *   • подписи (статусы, заголовки, короткие названия видов) приходят параметром `labels`,
 *     а не из словаря языков в коде;
 *   • статус `moved` один.
 *
 * ЧИСТАЯ АГРЕГАЦИЯ над строками, которые выбрал репозиторий, — чтобы правило подсчёта
 * проверялось юнит-тестом, а не глазами на проде.
 *
 * ПРАВИЛА ПОДСЧЁТА (PROCESS §5.6):
 *   • неделя — по ДАТЕ ВСТРЕЧИ, а не по дате записи;
 *   • перенесённая запись считается в «Перенос» у исходной встречи, а новая — у своей;
 *   • явка = пришли / (пришли + не пришли). Ещё не отмеченные в знаменатель не входят;
 *   • запись засчитывается тому, кто записал (bookedByUserId), даже если статус менял другой.
 */

import type { BookingStatus, EventBehavior } from './types';
import { toCsv, type CsvCell } from './csv';

export interface SummaryRow {
  id: string;
  eventTypeKey: string;
  behavior: EventBehavior;
  bookingDate: string;
  startTime: string;
  status: BookingStatus;
  isReserve: boolean;
  eventId: string | null;
  eventTitle: string | null;
  eventCapacity: number | null;
  consultantId: string | null;
  consultantName: string | null;
  bookedByUserId: string | null;
  bookedByName: string | null;
  clientName: string;
  clientPhone: string;
  /** Подпись направления запроса; '' — не выбрано. */
  direction: string;
}

export interface StatusCounts {
  total: number;
  registered: number;
  confirmed: number;
  attended: number;
  noShow: number;
  cancelled: number;
  moved: number;
  /** Процент с одним знаком; null — некого было отмечать. */
  attendanceRate: number | null;
}

export interface EventSummary extends StatusCounts {
  eventId: string;
  eventTypeKey: string;
  title: string;
  date: string;
  time: string;
  capacity: number | null;
}

export interface ConsultantSummary extends StatusCounts {
  consultantId: string | null;
  name: string | null;
  reserve: number;
}

export interface EmployeeSummary extends StatusCounts {
  userId: string | null;
  name: string | null;
  /** Записей по видам мероприятий: ключ вида → число. */
  byType: Record<string, number>;
}

export interface WeeklySummary {
  weekStart: string;
  weekEnd: string;
  totals: StatusCounts;
  byEvent: EventSummary[];
  byConsultant: ConsultantSummary[];
  byEmployee: EmployeeSummary[];
  rows: SummaryRow[];
}

/** Строка отчёта для экрана: без телефона клиента (см. summaryForScreen). */
export type ScreenSummaryRow = Omit<SummaryRow, 'clientPhone'>;

export interface WeeklySummaryScreen extends Omit<WeeklySummary, 'rows'> {
  rows: ScreenSummaryRow[];
}

/**
 * Отчёт для экрана (право read). Телефоны всех клиентов недели охраняет право export:
 * в JSON экрана их нет, иначе «выгрузку» собрали бы из ответа экрана, минуя CSV.
 */
export function summaryForScreen(summary: WeeklySummary): WeeklySummaryScreen {
  return {
    ...summary,
    rows: summary.rows.map((r) => {
      const rest: Partial<SummaryRow> = { ...r };
      delete rest.clientPhone;
      return rest as ScreenSummaryRow;
    }),
  };
}

function emptyCounts(): StatusCounts {
  return { total: 0, registered: 0, confirmed: 0, attended: 0, noShow: 0, cancelled: 0, moved: 0, attendanceRate: null };
}

function add(c: StatusCounts, status: BookingStatus): void {
  c.total += 1;
  if (status === 'registered') c.registered += 1;
  else if (status === 'confirmed') c.confirmed += 1;
  else if (status === 'attended') {
    // Пришедший клиент подтвердил визит, даже если подтверждение не отметили:
    // иначе в отчёте «Подтвердили 0» стоит рядом с «Пришли 4».
    c.attended += 1;
    c.confirmed += 1;
  } else if (status === 'no_show') c.noShow += 1;
  else if (status === 'cancelled') c.cancelled += 1;
  else c.moved += 1;
}

function finish<T extends StatusCounts>(c: T): T {
  const marked = c.attended + c.noShow;
  c.attendanceRate = marked === 0 ? null : Math.round((c.attended / marked) * 1000) / 10;
  return c;
}

export function summarizeWeek(rows: readonly SummaryRow[], weekStart: string, weekEnd: string): WeeklySummary {
  const totals = emptyCounts();
  const events = new Map<string, EventSummary>();
  const consultants = new Map<string, ConsultantSummary>();
  const employees = new Map<string, EmployeeSummary>();

  for (const r of rows) {
    add(totals, r.status);

    if (r.behavior === 'group' && r.eventId) {
      let e = events.get(r.eventId);
      if (!e) {
        e = {
          ...emptyCounts(),
          eventId: r.eventId,
          eventTypeKey: r.eventTypeKey,
          title: r.eventTitle ?? '',
          date: r.bookingDate,
          time: r.startTime,
          capacity: r.eventCapacity,
        };
        events.set(r.eventId, e);
      }
      add(e, r.status);
    }

    if (r.behavior === 'individual') {
      const key = r.consultantId ?? '';
      let c = consultants.get(key);
      if (!c) {
        c = { ...emptyCounts(), consultantId: r.consultantId, name: r.consultantName, reserve: 0 };
        consultants.set(key, c);
      }
      add(c, r.status);
      if (r.isReserve) c.reserve += 1;
    }

    const ekey = r.bookedByUserId ?? '';
    let emp = employees.get(ekey);
    if (!emp) {
      emp = { ...emptyCounts(), userId: r.bookedByUserId, name: r.bookedByName, byType: {} };
      employees.set(ekey, emp);
    }
    add(emp, r.status);
    emp.byType[r.eventTypeKey] = (emp.byType[r.eventTypeKey] ?? 0) + 1;
  }

  return {
    weekStart,
    weekEnd,
    totals: finish(totals),
    byEvent: [...events.values()].map(finish).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)),
    // Строка без консультанта («серые») — последней.
    byConsultant: [...consultants.values()].map(finish).sort((a, b) => (a.name ?? '￿').localeCompare(b.name ?? '￿')),
    byEmployee: [...employees.values()].map(finish).sort((a, b) => b.total - a.total || (a.name ?? '').localeCompare(b.name ?? '')),
    rows: [...rows],
  };
}

/** Подписи для CSV: приходят из настроек и локалей, ядро их не хранит. */
export interface SummaryCsvLabels {
  status: Record<BookingStatus, string>;
  /** Короткие названия видов мероприятий в порядке колонок: ключ вида → подпись. */
  typeShort: Readonly<Record<string, string>>;
  csv: {
    sectionEvents: string;
    sectionConsultants: string;
    sectionEmployees: string;
    sectionBookings: string;
    date: string;
    time: string;
    event: string;
    capacity: string;
    total: string;
    confirmed: string;
    attended: string;
    noShow: string;
    cancelled: string;
    moved: string;
    attendanceRate: string;
    consultant: string;
    reserve: string;
    employee: string;
    kind: string;
    target: string;
    client: string;
    phone: string;
    direction: string;
    bookedBy: string;
    status: string;
    unassigned: string;
    unknownEmployee: string;
    yes: string;
  };
}

/** CSV из четырёх блоков: мероприятия, консультанты, сотрудники, все записи. */
export function weeklySummaryCsv(summary: WeeklySummary, labels: SummaryCsvLabels): string {
  const c = labels.csv;
  const typeKeys = Object.keys(labels.typeShort);
  const rate = (v: number | null): CsvCell => (v === null ? '' : v);
  const out: CsvCell[][] = [];

  out.push([`${c.sectionEvents}: ${summary.weekStart} — ${summary.weekEnd}`]);
  out.push([c.date, c.time, c.event, c.capacity, c.total, c.confirmed, c.attended, c.noShow, c.cancelled, c.moved, c.attendanceRate]);
  for (const e of summary.byEvent) {
    out.push([e.date, e.time, e.title, e.capacity, e.total, e.confirmed, e.attended, e.noShow, e.cancelled, e.moved, rate(e.attendanceRate)]);
  }

  out.push([]);
  out.push([c.sectionConsultants]);
  out.push([c.consultant, c.total, c.attended, c.noShow, c.cancelled, c.moved, c.reserve, c.attendanceRate]);
  for (const k of summary.byConsultant) {
    out.push([k.name ?? c.unassigned, k.total, k.attended, k.noShow, k.cancelled, k.moved, k.reserve, rate(k.attendanceRate)]);
  }

  out.push([]);
  out.push([c.sectionEmployees]);
  out.push([c.employee, ...typeKeys.map((k) => labels.typeShort[k] ?? k), c.confirmed, c.attended, c.noShow, c.cancelled, c.moved, c.attendanceRate]);
  for (const p of summary.byEmployee) {
    out.push([
      p.name ?? c.unknownEmployee,
      ...typeKeys.map((k) => p.byType[k] ?? 0),
      p.confirmed, p.attended, p.noShow, p.cancelled, p.moved, rate(p.attendanceRate),
    ]);
  }

  out.push([]);
  out.push([c.sectionBookings]);
  out.push([c.date, c.time, c.kind, c.target, c.client, c.phone, c.direction, c.bookedBy, c.status, c.reserve]);
  const sorted = [...summary.rows].sort((a, b) => `${a.bookingDate} ${a.startTime}`.localeCompare(`${b.bookingDate} ${b.startTime}`));
  for (const r of sorted) {
    const target = r.behavior === 'group' ? r.eventTitle : (r.consultantName ?? c.unassigned);
    out.push([
      r.bookingDate,
      r.startTime,
      labels.typeShort[r.eventTypeKey] ?? r.eventTypeKey,
      target,
      r.clientName,
      r.clientPhone,
      r.direction,
      r.bookedByName ?? c.unknownEmployee,
      labels.status[r.status],
      r.isReserve ? c.yes : '',
    ]);
  }
  return toCsv(out);
}
