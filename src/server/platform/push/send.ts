// Отправка одного push (D-329): шифрование, VAPID, POST на адрес из закрытого списка, разбор ответа в код.
// Адрес подписки — секрет устройства: в журнал и в ошибки не попадает, только код итога.
import { checkPushEndpoint } from './endpoint';
import { encryptPushPayload, PushFormatError, vapidAuthorization, type VapidKeys } from './webpush';

export type PushSendResult =
  | { kind: 'sent' }
  /** 404/410: подписки у сервиса больше нет — выключить её. */
  | { kind: 'gone' }
  /** Временная ошибка (429, 5xx, сеть, таймаут) — повторить позже. */
  | { kind: 'retry'; code: string }
  /** Окончательная ошибка (формат, ключи, адрес, редирект) — не повторять. */
  | { kind: 'rejected'; code: string };

export type PushFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PushMessage {
  endpoint: string;
  p256dh: Buffer;
  auth: Buffer;
  /** Открытый текст (JSON без ПДн). */
  body: Uint8Array;
  /** Сколько секунд сервис хранит недоставленное. */
  ttlSec: number;
  urgency: 'normal' | 'high';
  /** Новое сообщение с той же темой заменяет недоставленное (до 32 знаков base64url). */
  topic?: string;
}

export const PUSH_TIMEOUT_MS = 10_000;

export async function sendWebPush(m: PushMessage, keys: VapidKeys, nowMs: number, fetchImpl: PushFetch = fetch): Promise<PushSendResult> {
  const url = checkPushEndpoint(m.endpoint);
  if (!url) return { kind: 'rejected', code: 'bad_endpoint' };
  let payload: Buffer;
  try {
    payload = encryptPushPayload({ uaPublic: m.p256dh, authSecret: m.auth, plaintext: m.body });
  } catch (e) {
    return { kind: 'rejected', code: e instanceof PushFormatError ? e.code : 'encrypt' };
  }
  const headers: Record<string, string> = {
    TTL: String(Math.max(0, Math.floor(m.ttlSec))),
    Urgency: m.urgency,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: vapidAuthorization(url.href, keys, nowMs),
  };
  if (m.topic && /^[A-Za-z0-9_-]{1,32}$/.test(m.topic)) headers.Topic = m.topic;
  let res: Response;
  try {
    res = await fetchImpl(url.href, { method: 'POST', headers, body: new Uint8Array(payload), redirect: 'manual', signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    return { kind: 'retry', code: name === 'TimeoutError' ? 'timeout' : 'network' };
  }
  // Тело ответа не читаем дальше заголовков: в нём бывает адрес подписки
  await res.body?.cancel().catch(() => undefined);
  const s = res.status;
  if (s >= 200 && s < 300) return { kind: 'sent' };
  if (s === 404 || s === 410) return { kind: 'gone' };
  if (s === 429 || s >= 500) return { kind: 'retry', code: `http_${s}` };
  if (s >= 300 && s < 400) return { kind: 'rejected', code: 'redirect' };
  return { kind: 'rejected', code: `http_${s}` };
}
