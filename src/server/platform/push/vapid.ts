// Ключи VAPID установки (D-329, CONFIG §7): из окружения, приватный ключ не в репозитории и не в БД.
// `crmctl install` генерирует пару функцией generateVapidKeys(); смена ключей обнуляет все подписки устройств.
import { createECDH, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { readEnv, type Env } from '../env';
import { b64u, isUncompressedPoint, type VapidKeys } from './webpush';

export type VapidProblem = 'missing' | 'bad_public' | 'bad_private' | 'mismatch' | 'bad_subject';
export type VapidRead = { ok: true; keys: VapidKeys } | { ok: false; code: VapidProblem };

/** `mailto:` с адресом или `https://` — так требует RFC 8292 §2.1; пробелов и кавычек нет (уходит в JWT). */
const SUBJECT_RE = /^(mailto:[^\s@"<>]+@[^\s@"<>]+|https:\/\/[^\s"<>]+)$/;

let memo: { raw: string; read: VapidRead } | null = null;

/** Разобрать и сверить ключи: приватный должен давать тот же открытый. Результат кэшируется по значениям окружения. */
export function readVapidKeys(env: Env = process.env): VapidRead {
  const pub = readEnv(env, 'VAPID_PUBLIC_KEY');
  const priv = readEnv(env, 'VAPID_PRIVATE_KEY');
  const subject = readEnv(env, 'VAPID_SUBJECT');
  const raw = `${pub ?? ''}\n${priv ?? ''}\n${subject ?? ''}`;
  if (memo && memo.raw === raw) return memo.read;
  const read = parse(pub, priv, subject);
  memo = { raw, read };
  return read;
}

function parse(pub: string | undefined, priv: string | undefined, subject: string | undefined): VapidRead {
  if (!pub || !priv || !subject) return { ok: false, code: 'missing' };
  if (!SUBJECT_RE.test(subject) || subject.length > 200) return { ok: false, code: 'bad_subject' };
  const publicKey = b64u.decode(pub);
  if (!isUncompressedPoint(publicKey)) return { ok: false, code: 'bad_public' };
  const d = b64u.decode(priv);
  if (!d || d.length !== 32) return { ok: false, code: 'bad_private' };
  try {
    // Пара сходится, только если открытый ключ, выведенный из приватного, совпадает с заданным
    // (createPrivateKey из JWK принимает чужие x, y без проверки — поэтому вывод через ECDH)
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    if (!ecdh.getPublicKey().equals(publicKey)) return { ok: false, code: 'mismatch' };
    const x = b64u.encode(publicKey.subarray(1, 33));
    const y = b64u.encode(publicKey.subarray(33, 65));
    const privateKey = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u.encode(d), x, y }, format: 'jwk' });
    return { ok: true, keys: { publicKey, privateKey, subject } };
  } catch {
    return { ok: false, code: 'bad_private' };
  }
}

/** Новая пара для `app.env`: обе части — base64url без '='. Пишет только `crmctl`, в журнал не выводится. */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const x = b64u.decode(jwk.x ?? '');
  const y = b64u.decode(jwk.y ?? '');
  if (!x || !y || !jwk.d) throw new Error('vapid: не удалось выгрузить ключ');
  return { publicKey: b64u.encode(Buffer.concat([Buffer.from([4]), x, y])), privateKey: jwk.d };
}
