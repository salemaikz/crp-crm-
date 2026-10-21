// Итоги другого сотрудника удалены с телефона по сроку (D-293 п. 2): телефон сообщает об этом до удаления, и запись
// журнала `user.outbox_expired` остаётся на сервере — потеря не молчаливая. Сотрудник, под чьей сессией пришёл запрос, —
// автор записи; сотрудник, чьи итоги удаляются, — объект. В журнале только id и число, без ПДн. Свои итоги так не
// удаляются (400): они уходят на сервер.
import { z } from 'zod';
import { BadRequestError, route } from '@/server/access';

const BODY_MAX_BYTES = 8 * 1024;
const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const Body = z
  .object({
    authorId: z.string().min(1).max(64),
    opIds: z.array(z.string().uuid()).min(1).max(100),
  })
  .strict();

type Result = { ok: true; authorId: string; count: number; opIds: string[]; deviceId: string };

export const POST = route(
  {
    perm: 'authenticated',
    audit: {
      action: 'user.outbox_expired',
      entity: 'user',
      entityId: (_c, r) => (r as Result).authorId,
      meta: (_c, r) => ({ count: (r as Result).count, opIds: (r as Result).opIds, deviceId: (r as Result).deviceId }),
    },
  },
  async ({ req, viewer }): Promise<Result> => {
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
    const opIds = [...new Set(body.opIds)];
    const device = req.headers.get('x-device-id') ?? '';
    return { ok: true, authorId: body.authorId, count: opIds.length, opIds, deviceId: DEVICE_ID.test(device) ? device : '' };
  },
);
