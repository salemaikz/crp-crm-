// Потеря итогов другого сотрудника на общем телефоне (D-293 п. 2, D-308). Телефон удаляет итоги со свободным текстом,
// пролежавшие дольше срока, и сообщает об этом; сервер пишет журнал `user.outbox_expired`. Это мутация безопасности:
// её не блокируют ни лицензия, ни роль «только чтение» (маршрут помечен ключом ядра `device.outbox_expire`).
// Журнал — след потери для руководителя, поэтому засорить его нельзя: автор — существующий сотрудник установки (иначе
// 404, как у несуществующего), opId, уже записанные звонками, отбрасываются (они дошли), частота ограничена по
// сотруднику и устройству. В meta раздельно: `claimed` — что заявил телефон (сервер проверить не может), `confirmed` —
// что сервер проверил сам. Без ПДн: только id, числа и id устройства.
import { NotFoundError, type Viewer } from '@/server/access';
import { writeAudit } from '@/server/platform/audit';
import { getDb } from '@/server/platform/db';
import { rateLimit } from '@/server/platform/ratelimit';
import { devicePendingOf, receivedCallIds, userExists } from './repo';

/**
 * Предел сообщений о потере за окно. Законный телефон шлёт по одному сообщению на автора (до 100 opId) при загрузке
 * страницы, и только пока в очереди есть неотправленное, — десятки в час не нужны. Общий предел сотрудника не даёт
 * обойти предел устройства, меняя `X-Device-Id`.
 */
export const EXPIRED_REPORT_LIMITS = { perDevice: 20, perUser: 60, windowMs: 3_600_000 } as const;

export type ExpiredReport = { authorId: string; opIds: readonly string[]; deviceId: string };
export type ExpiredResult = { ok: true } | { ok: false; retryAfterMs: number };

function limited(viewer: Viewer, deviceId: string, now: number): number | null {
  const { perDevice, perUser, windowMs } = EXPIRED_REPORT_LIMITS;
  const dev = rateLimit(`outbox-expired:dev:${viewer.userId}:${deviceId}`, perDevice, windowMs, now);
  if (!dev.ok) return dev.retryAfterMs;
  const user = rateLimit(`outbox-expired:user:${viewer.userId}`, perUser, windowMs, now);
  return user.ok ? null : user.retryAfterMs;
}

/**
 * Записать потерю итогов `authorId`. Свои итоги отсекает маршрут (400). Неизвестный автор → NotFoundError. Все opId уже
 * записаны звонками → ничего не пишется (потери нет). Ответ одинаковый (`ok`), сколько opId дошло — клиент не узнаёт.
 */
export async function reportExpiredOutbox(viewer: Viewer, r: ExpiredReport, now: number): Promise<ExpiredResult> {
  const retryAfterMs = limited(viewer, r.deviceId, now);
  if (retryAfterMs !== null) return { ok: false, retryAfterMs };
  const { sql } = await getDb();
  if (!(await userExists(sql, r.authorId))) throw new NotFoundError();
  const unique = [...new Set(r.opIds)];
  const received = new Set(await receivedCallIds(sql, unique));
  const lost = unique.filter((id) => !received.has(id));
  if (lost.length === 0) return { ok: true };
  await writeAudit(sql, {
    actorId: viewer.userId,
    action: 'user.outbox_expired',
    entity: 'user',
    entityId: r.authorId,
    spaceId: viewer.spaceId,
    meta: {
      claimed: { count: lost.length, opIds: lost, deviceId: r.deviceId },
      confirmed: {
        authorExists: true,
        alreadyReceived: received.size,
        authorPendingOnDevice: r.deviceId === '' ? null : await devicePendingOf(sql, r.authorId, r.deviceId),
      },
    },
  });
  return { ok: true };
}
