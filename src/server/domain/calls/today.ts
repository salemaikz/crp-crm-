// Сводка «Сегодня» для строки на экране «Звонить»: итоги, дозвоны, записи и пропуски сотрудника за местные сутки
// пространства. Считается на сервере по всем устройствам; телефон показывает свой счётчик только до ответа.
import { calling, time } from '@crm/core';
import { NotFoundError } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { countSkipsToday, selectTodayCounts } from './repo';
import type { GetToday } from './types';

export const getToday: GetToday = async (deps, viewer) => {
  const spaceId = viewer.spaceId;
  if (spaceId === null) throw new NotFoundError();
  const now = deps.now();
  const ctx = await deps.context(spaceId, now);
  const day = ctx.calendar.localDay(now);
  const from = time.fromLocalTime(day, '00:00', ctx.calendar.timezone);
  const to = time.fromLocalTime(time.addLocalDays(day, 1), '00:00', ctx.calendar.timezone);
  const sql = (await getDb()).sql;
  const [counts, skips] = await Promise.all([
    selectTodayCounts(sql, { spaceId, userId: viewer.userId, from, to, connectedKinds: calling.CONNECTED_KINDS }),
    countSkipsToday(sql, viewer.userId, day),
  ]);
  return { day, ...counts, skips, skipLimit: ctx.queue.skipLimit };
};
