// Web Push без стороннего пакета (D-329): шифрование тела aes128gcm (RFC 8291 поверх RFC 8188, одна запись) и
// заголовок VAPID (RFC 8292, ES256). Только node:crypto. Проверка — векторы RFC 8291 Appendix A (tests/unit/push).
// Здесь нет БД, сети и настроек: на вход — ключи и байты, на выход — байты и строка заголовка.
import { createCipheriv, createECDH, createHmac, randomBytes, sign, type KeyObject } from 'node:crypto';

/** Размер записи в заголовке (RFC 8291 §4: больше тела, одна запись). */
export const PUSH_RECORD_SIZE = 4096;
/** Наибольший открытый текст: 4096 − заголовок 86 − разделитель 1 − тег 16 (RFC 8291 §4). */
export const PUSH_MAX_PLAINTEXT = 3993;
/** Срок подписи VAPID: не больше суток (RFC 8292 §2), берём 12 ч. */
export const VAPID_TOKEN_TTL_SEC = 12 * 3600;

/** Ошибка формата ключей подписки или тела: код без значений. */
export class PushFormatError extends Error {
  constructor(readonly code: 'bad_p256dh' | 'bad_auth' | 'too_large') {
    super(code);
    this.name = 'PushFormatError';
  }
}

export const b64u = {
  encode: (b: Uint8Array): string => Buffer.from(b).toString('base64url'),
  /** Строгий разбор: только алфавит base64url без '='; иначе null. */
  decode: (s: string): Buffer | null => (/^[A-Za-z0-9_-]*$/.test(s) ? Buffer.from(s, 'base64url') : null),
};

const hmac = (key: Uint8Array, data: Uint8Array): Buffer => createHmac('sha256', key).update(data).digest();

/** Несжатая точка P-256: 65 байт, первый 0x04. */
export const isUncompressedPoint = (b: Uint8Array | null): b is Buffer => b !== null && b.length === 65 && b[0] === 4;

export interface EncryptInput {
  /** Ключ ECDH устройства (`p256dh`), несжатая точка. */
  uaPublic: Uint8Array;
  /** Секрет аутентификации устройства (`auth`), 16 байт. */
  authSecret: Uint8Array;
  plaintext: Uint8Array;
  /** Только тесты (вектор RFC): закрытый ключ отправителя; иначе — новый на каждое сообщение. */
  senderPrivate?: Uint8Array;
  /** Только тесты: соль; иначе 16 случайных байт. */
  salt?: Uint8Array;
}

/** Тело запроса к push-сервису: заголовок (salt, rs, keyid = открытый ключ отправителя) и одна зашифрованная запись. */
export function encryptPushPayload(i: EncryptInput): Buffer {
  if (!isUncompressedPoint(Buffer.from(i.uaPublic))) throw new PushFormatError('bad_p256dh');
  if (i.authSecret.length !== 16) throw new PushFormatError('bad_auth');
  if (i.plaintext.length > PUSH_MAX_PLAINTEXT) throw new PushFormatError('too_large');
  const ecdh = createECDH('prime256v1');
  if (i.senderPrivate) ecdh.setPrivateKey(Buffer.from(i.senderPrivate));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  let secret: Buffer;
  try {
    secret = ecdh.computeSecret(Buffer.from(i.uaPublic));
  } catch {
    throw new PushFormatError('bad_p256dh'); // точка не на кривой
  }
  // RFC 8291 §3.3–3.4: IKM из общего секрета и секрета аутентификации, затем CEK и nonce по RFC 8188
  const prkKey = hmac(i.authSecret, secret);
  const keyInfo1 = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), Buffer.from(i.uaPublic), asPublic, Buffer.from([1])]); // key_info || 0x01
  const ikm = hmac(prkKey, keyInfo1);
  const salt = i.salt ? Buffer.from(i.salt) : randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // Последняя (и единственная) запись: разделитель 0x02 без дополнения
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(i.plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(PUSH_RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

export interface VapidKeys {
  /** Открытый ключ сервера приложения, несжатая точка (он же `applicationServerKey` в браузере). */
  publicKey: Buffer;
  privateKey: KeyObject;
  /** `mailto:` или `https:` — адрес связи для push-сервиса. */
  subject: string;
}

/** Заголовок Authorization по схеме `vapid` (RFC 8292 §3): JWT ES256 на источник адреса подписки. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, nowMs: number): string {
  const aud = new URL(endpoint).origin;
  const head = b64u.encode(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u.encode(Buffer.from(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + VAPID_TOKEN_TTL_SEC, sub: keys.subject })));
  const input = `${head}.${claims}`;
  const sig = sign('sha256', Buffer.from(input), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u.encode(sig)}, k=${b64u.encode(keys.publicKey)}`;
}
