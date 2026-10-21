// Полная выгрузка, шаг 1 (R3b §2.5, D-264): POST {password} → {ticket, expiresAt}. Пароль идёт только телом JSON, в адрес
// и журналы не попадает. Неверный пароль — 403 `password_invalid` без записи в журнал; лимиты — 429. Работает при любой
// лицензии и у роли «только чтение»: `data.export_all` — разрешение вида export, не мутация (D-054).
import { z } from 'zod';
import { BadRequestError, route } from '@/server/access';
import { issueFullExportTicket } from '@/server/domain/reports';
import { exportGuard } from '../../_lib';

const Body = z.object({ password: z.string().min(1).max(256) }).strict();

export const POST = route({ perm: 'data.export_all' }, async ({ req, viewer }) =>
  exportGuard(async () => {
    const text = await req.text();
    if (text.length > 2048) throw new BadRequestError('invalid');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new BadRequestError('invalid');
    }
    const body = Body.safeParse(raw);
    if (!body.success) throw new BadRequestError('invalid');
    return issueFullExportTicket(viewer, { password: body.data.password });
  }),
);
