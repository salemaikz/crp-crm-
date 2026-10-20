// Формат лицензии (ARCHITECTURE §8.4, D-029, D-211): `CRM1.<base64url(JSON)>.<base64url(подпись)>`.
// Подпись Ed25519 покрывает ASCII-строку `CRM1.<base64url(JSON)>` — префикс входит в подпись, поэтому
// подпись не переносится на другой формат. Ядро только разбирает и проверяет; подписывает владелец
// утилитой scripts/license-sign.ts своим закрытым ключом вне репозитория.
import { z } from 'zod';

export const LICENSE_PREFIX = 'CRM1';
/** Предел длины строки лицензии: защита разбора от мусора в файле. */
export const LICENSE_MAX_LENGTH = 8192;
export const DAY_MS = 86_400_000;

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const KID_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const INSTALL_RE = /^[0-9A-Za-z-]{8,64}$/;
const FEATURE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ms = z.number().int().nonnegative().max(8_640_000_000_000_000);

/** Содержимое лицензии. Время — epoch-мс. Незнакомые поля игнорируются (их добавит новая `v` при несовместимости). */
export const licensePayloadSchema = z
  .object({
    v: z.literal(1),
    /** Номер лицензии у владельца (журнал выдачи вне репозитория). */
    lid: z.string().regex(ID_RE),
    /** Ключ подписи: по нему выбирается открытый ключ, вшитый в ядро. */
    kid: z.string().regex(KID_RE),
    /** Клиент; в сборке клиента совпадает с водяным знаком `CUSTOMER_ID`. */
    customer: z.string().regex(ID_RE),
    installId: z.string().regex(INSTALL_RE),
    issuedAt: ms,
    notBefore: ms,
    expiresAt: ms,
    graceDays: z.number().int().min(0).max(365),
    features: z.array(z.string().regex(FEATURE_RE)).max(64),
    /** Мягкий предел мест (ARCHITECTURE §8.4); проверяет приглашение, не лицензия. */
    seats: z.number().int().positive().max(100_000).optional(),
    /** Если задан — лицензия только для этой сборки (водяной знак `BUILD_ID`). */
    buildId: z.string().regex(ID_RE).optional(),
  })
  .refine((p) => p.notBefore < p.expiresAt && p.issuedAt < p.expiresAt, { message: 'срок пуст' })
  .refine((p) => new Set(p.features).size === p.features.length, { message: 'повтор в features' });

export type LicensePayload = z.infer<typeof licensePayloadSchema>;

/** Почему лицензия не принята. Коды — для журнала и `crmctl license status`, без текста. */
export type InvalidReason =
  | 'malformed'
  | 'unsupported_version'
  | 'unknown_kid'
  | 'test_key_in_client_build'
  | 'bad_signature'
  | 'wrong_install'
  | 'wrong_customer'
  | 'wrong_build'
  | 'not_yet_valid';

export type Decoded = {
  payload: LicensePayload;
  /** Байты, которые подписаны: ASCII `CRM1.<payload>`. */
  signed: Uint8Array;
  signature: Uint8Array;
};

export type DecodeResult = { ok: true; value: Decoded } | { ok: false; reason: 'malformed' | 'unsupported_version' };

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function fromBase64Url(s: string): Uint8Array | null {
  if (!B64URL_RE.test(s)) return null;
  const b = Buffer.from(s, 'base64url');
  // Строгость: base64url без «лишних» битов — одна лицензия имеет ровно одну запись
  return b.toString('base64url') === s ? new Uint8Array(b) : null;
}

/** Часть, которую подписывает владелец: `CRM1.<base64url(JSON)>`. */
export function signingInput(payload: LicensePayload): string {
  return `${LICENSE_PREFIX}.${toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))}`;
}

/** Готовая строка лицензии из подписанной части и подписи. */
export function assembleLicense(signed: string, signature: Uint8Array): string {
  return `${signed}.${toBase64Url(signature)}`;
}

/** Разбор без проверки подписи (подпись проверяет verifyLicense). Пробелы и перевод строки по краям допустимы. */
export function decodeLicense(raw: string): DecodeResult {
  const text = raw.trim();
  if (text.length === 0 || text.length > LICENSE_MAX_LENGTH) return { ok: false, reason: 'malformed' };
  const parts = text.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [prefix, body, sig] = parts as [string, string, string];
  if (prefix !== LICENSE_PREFIX) return { ok: false, reason: prefix.startsWith('CRM') ? 'unsupported_version' : 'malformed' };
  const json = fromBase64Url(body);
  const signature = fromBase64Url(sig);
  if (!json || !signature || signature.length !== 64) return { ok: false, reason: 'malformed' };
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof data === 'object' && data !== null && 'v' in data && (data as { v: unknown }).v !== 1) {
    return { ok: false, reason: 'unsupported_version' };
  }
  const parsed = licensePayloadSchema.safeParse(data);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  return { ok: true, value: { payload: parsed.data, signed: new TextEncoder().encode(`${prefix}.${body}`), signature } };
}
