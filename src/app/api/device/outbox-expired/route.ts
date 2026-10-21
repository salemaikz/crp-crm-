// Итоги другого сотрудника удалены с телефона по сроку (D-293 п. 2, D-308): телефон сообщает об этом, сервер пишет
// журнал `user.outbox_expired` — потеря не молчаливая. Сотрудник, под чьей сессией пришёл запрос, — автор записи;
// сотрудник, чьи итоги удалены, — объект. Мутация безопасности (D-054): ПДн уходят с общего телефона при любой лицензии
// и для роли «только чтение». Свои итоги так не удаляются (400): они уходят на сервер. Проверки журнала, частота и
// разделение «заявлено телефоном» / «подтверждено сервером» — в домене (reportExpiredOutbox).
import { z } from 'zod';
import { BadRequestError, route } from '@/server/access';
import { reportExpiredOutbox } from '@/server/domain/calls';
import { rateLimited } from '@/server/platform/http/body';

const BODY_MAX_BYTES = 8 * 1024;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const Body = z
  .object({
    authorId: z.string().min(1).max(64),
    opIds: z.array(z.string().uuid()).min(1).max(100),
  })
  .strict();

export const POST = route({ perm: 'authenticated', securityMutation: 'device.outbox_expire' }, async ({ req, viewer }) => {
  const text = await req.text();
  if (text.length > BODY_MAX_BYTES) throw new BadRequestError('too_large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequestError('json');
  }
  const body = Body.parse(raw);
  if (body.authorId === viewer.userId) throw new BadRequestError('own_outbox');
  const device = req.headers.get('x-device-id') ?? '';
  const res = await reportExpiredOutbox(viewer, { authorId: body.authorId, opIds: body.opIds, deviceId: DEVICE_ID.test(device) ? device : '' }, Date.now());
  return res.ok ? { ok: true } : rateLimited(res.retryAfterMs);
});
