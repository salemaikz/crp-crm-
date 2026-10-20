// GET — настройки продаж для экрана; PATCH — патч разрешённых путей (белый список, ревизия с expectedRev).
import { route } from '@/server/access';
import { getSalesSettings, patchSalesSettings, SalesPatchInput } from '@/server/domain/admin';
import { readBody, withIssues } from '../_lib';

export const GET = route({ perm: 'authenticated' }, async ({ viewer }) => getSalesSettings(viewer));

export const PATCH = route({ perm: 'settings.sales' }, async ({ req, viewer }) =>
  withIssues(async () => patchSalesSettings(viewer, await readBody(req, SalesPatchInput))),
);
