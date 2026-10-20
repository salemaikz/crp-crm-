// `GET /api/ingest/v1/demand` (INTEGRATIONS 5.3, D-057): сколько новых карточек нужно CRM. Только числа.
// Формулу считает чистое ядро (`distribution.computeDemand`), здесь — сбор чисел из БД.
import { distribution, time } from '@crm/core';
import { getDb } from '@/server/platform/db';
import { isAccepting } from './gate';
import * as repo from './repo';
import { intakeSettings } from './settings';
import type { DemandResponse, IngestPrincipal } from './types';

export async function demandFor(principal: IngestPrincipal, now: number = Date.now()): Promise<DemandResponse> {
  const { global, space } = await intakeSettings(principal);
  const tz = global.org.timezone;
  const calendar = time.createWorkCalendar({
    timezone: tz,
    workdays: global.calendar.workdays,
    workHours: global.calendar.workHours,
    callWindow: global.calendar.callWindow,
    holidays: global.calendar.holidays,
  });
  const dcal = distribution.toDistributionCalendar(calendar);
  const today = calendar.localDay(now);
  const futureDays = distribution.workdaysAfter(today, space.intake.demandWorkdays, dcal);
  // Возврат «до конца дня D»: последняя миллисекунда местных суток
  const dayEnd = (day: string): number => time.fromLocalTime(time.addLocalDays(day, 1), '00:00', tz) - 1;
  const horizonEnd = dayEnd(futureDays[futureDays.length - 1] ?? today);

  const db = await getDb();
  const roles = space.distribution.participantRoles;
  const data = await db.tx(async (sql) => {
    const [todayOps, futureOps, issued, returns, poolReady] = await Promise.all([
      repo.operatorsByDay(sql, principal.spaceId, roles, [today], today),
      repo.operatorsByDay(sql, principal.spaceId, roles, futureDays, null),
      repo.issuedOnDay(sql, principal.spaceId, today),
      repo.returnDates(sql, principal.spaceId, horizonEnd),
      repo.poolReadyCount(sql, principal.spaceId),
    ]);
    return { todayOps: todayOps.get(today) ?? 0, futureOps, issued, returns, poolReady };
  });

  const result = distribution.computeDemand({
    now,
    calendar: dcal,
    schedule: space.distribution.schedule,
    capPerOperator: space.distribution.dailyCap,
    bufferDays: space.intake.bufferDays,
    todayOperators: data.todayOps,
    issuedToday: data.issued,
    days: futureDays.map((date) => ({ date, operators: data.futureOps.get(date) ?? 0 })),
    returnsExpected: data.returns.length,
    returnsDueBy: (day) => {
      const end = dayEnd(day);
      return data.returns.filter((t) => t <= end).length;
    },
    poolReady: data.poolReady,
  });

  return {
    asOf: now,
    timezone: tz,
    accepting: await isAccepting(),
    maxBatch: space.intake.maxBatch,
    horizonWorkdays: space.intake.demandWorkdays,
    ...result,
  };
}
