// Идентификатор устройства и заголовки D-063: X-Device-Id, X-Outbox-Pending, X-Outbox-Last-Flush.
// Сервер хранит последнее значение по устройству (без ПДн) и показывает руководителю «Не отправлено с устройств».
import type { OutboxStore } from './outboxStore';

const META_KEY = 'deviceId';
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Случайный id: 22 символа base64url из 16 случайных байт. */
export function newDeviceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `d${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export async function ensureDeviceId(store: OutboxStore): Promise<string> {
  const saved = await store.getMeta(META_KEY);
  if (saved && ID_RE.test(saved)) return saved;
  const id = newDeviceId();
  await store.setMeta(META_KEY, id);
  return id;
}

export function deviceHeaders(deviceId: string, pending: number, lastFlushAt: number | null): Record<string, string> {
  return {
    'X-Device-Id': deviceId,
    'X-Outbox-Pending': String(Math.min(Math.max(0, Math.trunc(pending)), 10_000)),
    'X-Outbox-Last-Flush': lastFlushAt === null ? '' : String(Math.trunc(lastFlushAt)),
  };
}
