// Записи и явка за период (PROCESS 10): по типу события, консультанту или автору записи; по дате встречи, без резерва.
import { rate, toKzt } from './definitions';
import type { AttendanceListSqlRow, AttendancePurchaseRow, AttendanceSqlRow } from './periodRepo';
import { ATTENDANCE_LIST_STATUSES, type AttendanceListReport, type AttendanceListStatus, type AttendanceReport, type AttendanceRow, type ResolvedPeriod } from './reportTypes';

type Totals = Omit<AttendanceRow, 'key' | 'name'>;

function fin(t: Omit<Totals, 'rate'>): Totals {
  return { ...t, rate: rate(t.attended, t.attended + t.noShow) };
}

export function buildAttendanceReport(i: {
  period: ResolvedPeriod;
  by: AttendanceReport['by'];
  rows: readonly AttendanceSqlRow[];
  purchases: readonly AttendancePurchaseRow[];
  /** Имена для consultant и author; у event_type — подписи строит интерфейс. */
  names: ReadonlyMap<string, string>;
}): AttendanceReport {
  const deals = new Map<string, Set<string>>();
  const allDeals = new Set<string>();
  for (const p of i.purchases) {
    const set = deals.get(p.grp) ?? new Set<string>();
    set.add(p.dealId);
    deals.set(p.grp, set);
    allDeals.add(p.dealId);
  }
  const groups = new Set([...i.rows.map((r) => r.grp), ...deals.keys()]);
  const byGrp = new Map(i.rows.map((r) => [r.grp, r]));
  const rows: AttendanceRow[] = [...groups].map((key) => {
    const r = byGrp.get(key);
    const t = fin({
      booked: r?.booked ?? 0,
      attended: r?.attended ?? 0,
      noShow: r?.noShow ?? 0,
      unmarked: r?.unmarked ?? 0,
      cancelled: r?.cancelled ?? 0,
      purchases: deals.get(key)?.size ?? 0,
    });
    return { key, name: i.by === 'event_type' || key === '' ? null : (i.names.get(key) ?? ''), ...t };
  });
  rows.sort((x, y) => y.booked - x.booked || x.key.localeCompare(y.key));
  const sum = (pick: (r: AttendanceRow) => number) => rows.reduce((s, r) => s + pick(r), 0);
  // Покупки в итоге — различные сделки: одна сделка с записями в двух группах считается один раз
  const total = fin({
    booked: sum((r) => r.booked),
    attended: sum((r) => r.attended),
    noShow: sum((r) => r.noShow),
    unmarked: sum((r) => r.unmarked),
    cancelled: sum((r) => r.cancelled),
    purchases: allDeals.size,
  });
  return { period: i.period, by: i.by, rows, total };
}

// ---------------------------------------------------------------------------
// Явка — список (D-344)
// ---------------------------------------------------------------------------

const CURSOR_RE = /^(\d{1,15})\.([A-Za-z0-9_-]{1,64})$/;

/** Курсор страницы: `<starts_at>.<id>` последней показанной записи. */
export function encodeListCursor(startsAt: number | string, id: string): string {
  return `${startsAt}.${id}`;
}

/** Разбор курсора; чужая форма — null (вызывающий отвечает 400). */
export function decodeListCursor(raw: string): { startsAt: number; id: string } | null {
  const m = CURSOR_RE.exec(raw);
  return m ? { startsAt: Number(m[1]), id: m[2] as string } : null;
}

const STATUS_SET: ReadonlySet<string> = new Set(ATTENDANCE_LIST_STATUSES);

/** Страница списка из строк репозитория (запрошено `limit + 1`, лишняя строка — признак следующей страницы). */
export function buildAttendanceList(i: { period: ResolvedPeriod; rows: readonly AttendanceListSqlRow[]; limit: number }): AttendanceListReport {
  const page = i.rows.slice(0, i.limit);
  const last = page[page.length - 1];
  return {
    period: i.period,
    rows: page.map((r) => ({
      bookingId: r.bookingId,
      date: r.date,
      startTime: r.startTime,
      eventTypeKey: r.eventTypeKey,
      clientId: r.clientId,
      clientName: r.clientName,
      bookedByUserId: r.bookedByUserId,
      bookedByName: r.bookedByName,
      status: (STATUS_SET.has(r.status) ? r.status : 'planned') as AttendanceListStatus,
      markedByUserId: r.markedByUserId,
      markedByName: r.markedByName,
      consultantUserId: r.consultantUserId,
      consultantName: r.consultantName,
      purchaseSumKzt: r.purchaseSumKzt === null ? null : toKzt(r.purchaseSumKzt),
    })),
    next: i.rows.length > i.limit && last ? encodeListCursor(last.startsAt, last.bookingId) : null,
  };
}
