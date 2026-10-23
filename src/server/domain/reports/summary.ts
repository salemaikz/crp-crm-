// Сводка дня РОП (PROCESS §10.2): плитки и таблица операторов за сегодняшние местные сутки.
// Читает отчёт, ничего не пишет. Директор (`report.view` с охватом пространства) получает то же, только чтение.
import { calling, time } from '@crm/core';
import { scopeOf } from '@/server/access';
import { getPool } from '@/server/domain/distribution';
import { getDb } from '@/server/platform/db';
import { dueBoundsAt } from '@/server/domain/calls/dueBounds';
import { requireSpaceReports } from './access';
import { buildOperatorRows, roomToday } from './compose';
import { reportsDeps } from './deps';
import {
  countGreyBookings,
  selectBookingDays,
  selectBookingsCreated,
  selectCallStats,
  selectDeviceStatus,
  selectIssuedToday,
  selectOverdueCallbacks,
  selectPoolCounts,
  selectSkips,
  selectStaff,
} from './repo';
import type { BookingDayTile, GetSummary, Summary } from './types';

const NO_BOOKINGS: BookingDayTile = { total: 0, confirmed: 0 };

export const getSummary: GetSummary = async (viewer): Promise<Summary> => {
  const spaceId = requireSpaceReports(viewer);
  const deps = reportsDeps();
  const now = deps.now();
  const cfg = await deps.config(spaceId, now);
  const { timeZone, settings, calendar } = cfg.distribution;
  const day = calendar.localDay(now);
  const tomorrow = time.addLocalDays(day, 1);
  const from = time.fromLocalTime(day, '00:00', timeZone);
  const to = time.fromLocalTime(tomorrow, '00:00', timeZone);
  // Одно правило просрочки ядра (§4.3): границы считаются один раз
  const bounds = dueBoundsAt(now, cfg.overdueAlertMinutes, calendar);
  const db = await getDb();
  const sql = db.sql;

  const staff = await selectStaff(sql, { spaceId, roles: cfg.distribution.participantRoles, today: day });
  const userIds = staff.map((s) => s.userId);
  // Постоянное число запросов (не по числу операторов); независимы — идут параллельно.
  const [issued, calls, bookings, skips, overdue, devices, bookingDays, grey] = await Promise.all([
    selectIssuedToday(sql, { spaceId, day }),
    selectCallStats(viewer, sql, { spaceId, from, to, timeZone, connectedKinds: calling.CONNECTED_KINDS }),
    selectBookingsCreated(viewer, sql, { spaceId, from, to }),
    selectSkips(sql, { spaceId, day, userIds }),
    selectOverdueCallbacks(viewer, sql, { spaceId, bounds }),
    selectDeviceStatus(sql, { userIds }),
    selectBookingDays(viewer, sql, { spaceId, days: [day, tomorrow] }),
    countGreyBookings(viewer, sql, { spaceId, fromDay: day }),
  ]);

  const operators = buildOperatorRows({
    staff,
    today: day,
    cap: settings.dailyCap,
    capIncludes: settings.capIncludes,
    target: cfg.callsPerHourTarget,
    issued,
    calls,
    bookings,
    skips,
    overdue,
    devices,
  });

  // Пул: с `pool.read` — те же числа, что на экране «Раздача» (с поправкой на блокировку пар D-174).
  let pool: Summary['tiles']['pool'];
  if (scopeOf(viewer, 'pool.read') !== null) {
    const p = (await getPool(viewer, { cursor: null, limit: 1 })).summary;
    pool = { ready: p.ready, overCap: p.overCap, duplicates: p.held['hold:dup_pair'], disputed: p.held['hold:import_conflict'] };
  } else {
    const p = await selectPoolCounts(viewer, sql, { spaceId });
    pool = { ready: p.ready, overCap: Math.max(0, p.ready - roomToday(operators)), duplicates: p.held['dup_pair'] ?? 0, disputed: p.held['import_conflict'] ?? 0 };
  }

  const byDay = new Map(bookingDays.map((r) => [r.day, { total: r.total, confirmed: r.confirmed }]));
  const overdueCards = overdue.reduce((sum, r) => sum + r.n, 0);
  const unsentRows = devices.filter((d) => d.pending > 0);
  const accepting = operators.filter((o) => o.status !== 'absent' && staff.find((s) => s.userId === o.userId)?.inDistribution);

  return {
    generatedAt: now,
    day,
    timeZone,
    overdueAlertMinutes: cfg.overdueAlertMinutes,
    callsPerHourTarget: cfg.callsPerHourTarget,
    tiles: {
      pool,
      issued: { issued: operators.reduce((sum, o) => sum + o.issued, 0), cap: settings.dailyCap * accepting.length, operators: accepting.length },
      grey: { waiting: grey },
      bookings: { today: byDay.get(day) ?? NO_BOOKINGS, tomorrow: byDay.get(tomorrow) ?? NO_BOOKINGS },
      overdue: { cards: overdueCards, operators: overdue.filter((r) => r.n > 0).length },
      unsent: { pending: unsentRows.reduce((sum, d) => sum + d.pending, 0), operators: unsentRows.length },
    },
    alarm: overdueCards > 0,
    operators,
  };
};
