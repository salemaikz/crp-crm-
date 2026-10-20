// GET — праздники и переносы (вместе с остальными настройками экрана); PUT — замена списка, только администратор.
import { route } from '@/server/access';
import { getSalesSettings, HolidaysInput, putHolidays } from '@/server/domain/admin';
import { readBody, withIssues } from '../_lib';

export const GET = route({ perm: 'authenticated' }, async ({ viewer }) => {
  const v = await getSalesSettings(viewer);
  return { revs: { global: v.revs.global }, holidays: v.holidays, can: { holidays: v.can.holidays }, year: v.year };
});

export const PUT = route({ perm: 'admin' }, async ({ req, viewer }) =>
  withIssues(async () => putHolidays(viewer, await readBody(req, HolidaysInput))),
);
