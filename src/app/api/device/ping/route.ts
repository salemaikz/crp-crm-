// Пинг устройства оператора (D-063, D-178, calls-design §10): раз в 5 минут, пока приложение открыто, несёт
// X-Device-Id / X-Outbox-Pending / X-Outbox-Last-Flush. Пишет device_status той же recordDeviceStatus, что и
// маршруты обзвона. Только сессия: данные личные (user_id берётся из сессии, не из запроса); тела нет.
import { BadRequestError, route } from '@/server/access';
import { parseDeviceHeaders, recordDeviceStatus } from '@/server/domain/calls';

export const POST = route({ perm: 'authenticated' }, async ({ req, viewer }) => {
  const report = parseDeviceHeaders(req.headers);
  if (!report) throw new BadRequestError('device_headers');
  // Ошибка записи уходит только в лог: клиенту незачем повторять пинг
  await recordDeviceStatus(viewer, report, Date.now());
  return { ok: true };
});
