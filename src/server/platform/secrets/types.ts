// Секреты интеграций (INTEGRATIONS §7, D-269, дизайн docs/reports-plugins-design.md §7.4): СИГНАТУРЫ.
// AES-256-GCM, случайный IV 12 байт, AAD = `${integrationId}|${name}|${kid}`; ключ — только из окружения
// (CRM_SECRETS_KID, CRM_SECRETS_KEY_<kid>: base64 32 байта). Тела — builder: keys.ts, aesgcm.ts, repo.ts, index.ts.
// Открытый секрет не пишется в логи, ошибки и аудит; наружу из платформы — только внутри вызова плагина.
import type { Sql } from '../db';

/** Зашифрованная строка integration_secrets. */
export interface SealedSecret {
  kid: string;
  iv: Uint8Array;
  ciphertext: Uint8Array;
  tag: Uint8Array;
}

/** Ключи из окружения: текущий kid и все известные (для расшифровки до ротации). */
export interface SecretKeyring {
  currentKid: string;
  keys: ReadonlyMap<string, Uint8Array>;
}

/** Ошибки без подробностей: `no_key` (нет ключа или он не 32 байта), `unknown_kid`, `auth_failed` (подмена или чужой AAD). */
export type SecretErrorCode = 'no_key' | 'unknown_kid' | 'auth_failed' | 'not_found';

/** Ключи из окружения. Production без ключа — SecretError('no_key') при первом использовании; dev/test — постоянный тестовый ключ. */
export type LoadKeyring = (env?: Record<string, string | undefined>) => SecretKeyring;

export type SealSecret = (ring: SecretKeyring, input: { integrationId: string; name: string; plaintext: string }) => SealedSecret;
export type OpenSecret = (ring: SecretKeyring, input: { integrationId: string; name: string; sealed: SealedSecret }) => string;

/** Записать (upsert по PK), `last4` — последние 4 символа для UI («задан, …abcd»). */
export type PutIntegrationSecret = (sql: Sql, input: { integrationId: string; name: string; plaintext: string; now: number }) => Promise<void>;
/** Прочитать и расшифровать; нет строки — SecretError('not_found'). */
export type GetIntegrationSecret = (sql: Sql, input: { integrationId: string; name: string }) => Promise<string>;
/** Удалить секреты подключения (отключение с очисткой ключа). */
export type DeleteIntegrationSecrets = (sql: Sql, integrationId: string) => Promise<number>;
/** «задан, …abcd» для UI: имена и last4, без расшифровки. */
export type DescribeIntegrationSecrets = (sql: Sql, integrationId: string) => Promise<{ name: string; last4: string; updatedAt: number }[]>;

/** `crmctl secrets rotate`: перешифровать строки с kid ≠ текущего; по 100 строк в транзакции; итог — числа. */
export type RotateSecrets = (sql: Sql, ring: SecretKeyring) => Promise<{ rotated: number; failed: number }>;
