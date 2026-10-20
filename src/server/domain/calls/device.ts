// Статус устройства оператора (D-063, D-178): счётчик неотправленных итогов из заголовков запроса.
// Пишется отдельно от основной работы запроса; ошибка — только в лог, ответ не меняется.
import type { SystemActor } from '@/server/access';
import { getDb } from '@/server/platform/db';
import { deleteDeviceStatusBefore, upsertDeviceStatus } from './repo';
import { DEVICE_HEADERS, type DeviceReport, type ParseDeviceHeaders, type RecordDeviceStatus } from './types';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NUM_RE = /^\d{1,16}$/;

/** X-Device-Id (1–64 [A-Za-z0-9_-]), X-Outbox-Pending (0–10 000), X-Outbox-Last-Flush (epoch-мс или пусто). Мусор → null. */
export const parseDeviceHeaders: ParseDeviceHeaders = (headers: Headers): DeviceReport | null => {
  const deviceId = headers.get(DEVICE_HEADERS.deviceId)?.trim() ?? '';
  if (!ID_RE.test(deviceId)) return null;
  const pendingRaw = headers.get(DEVICE_HEADERS.pending)?.trim() ?? '';
  if (!NUM_RE.test(pendingRaw)) return null;
  const pending = Number(pendingRaw);
  if (pending > 10_000) return null;
  const flushRaw = headers.get(DEVICE_HEADERS.lastFlush)?.trim() ?? '';
  if (flushRaw !== '' && !NUM_RE.test(flushRaw)) return null;
  return { deviceId, pending, lastFlushAt: flushRaw === '' ? null : Number(flushRaw) };
};

export const recordDeviceStatus: RecordDeviceStatus = async (viewer, report, now) => {
  try {
    const db = await getDb();
    await upsertDeviceStatus(db.sql, { userId: viewer.userId, deviceId: report.deviceId, pending: report.pending, lastFlushAt: report.lastFlushAt, now });
  } catch (e) {
    console.error('[calls] не записан статус устройства:', e instanceof Error ? e.message : 'ошибка');
  }
};

/** Для `purge` воркера: устаревшие строки статуса устройств. Возвращает число удалённых. */
export async function purgeDeviceStatus(_actor: SystemActor, before: number): Promise<number> {
  return deleteDeviceStatusBefore((await getDb()).sql, before);
}
