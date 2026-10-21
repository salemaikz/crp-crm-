// Откуда сервер берёт ключи, водяной знак, файл лицензии, часы и монотонное время (D-211, D-306). В production — только из сборки
// ядра и окружения установки; подмена — только в тестах (testing.ts, в production бросает).
import { readFile } from 'node:fs/promises';
import { license as coreLicense } from '@crm/core';
import type { TrustedKeys, Watermark } from '@crm/core/license';
import { readEnv, type Env } from '../env';

/** Путь по умолчанию: том лицензии в compose (deploy/compose/compose.yaml, CONFIG §7 LICENSE_PATH). */
export const DEFAULT_LICENSE_PATH = '/var/lib/crm/license/license.crm';
/** Файл больше этого — не лицензия: не читаем целиком в память. */
const MAX_FILE_BYTES = 16 * 1024;

export type LicenseEnv = {
  keys: TrustedKeys;
  watermark: Watermark;
  /** Текст файла лицензии; null — файла нет. */
  readFile: () => Promise<string | null>;
  clock: () => number;
  /** Монотонное время процесса (performance.now()): переводом системных часов не сдвигается (D-306). */
  mono: () => number;
};

export function licensePath(e: Env = process.env): string {
  return readEnv(e, 'LICENSE_PATH') ?? DEFAULT_LICENSE_PATH;
}

export async function readLicenseFile(path: string): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await readFile(path);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return null;
    throw err;
  }
  // Слишком большой файл обрезается и не пройдёт разбор (malformed), а не подменяется копией из БД
  return buf.subarray(0, MAX_FILE_BYTES).toString('utf8');
}

/** Боевое окружение: ключи и водяной знак — только из сборки ядра (окружением их не подменить). */
export function defaultLicenseEnv(e: Env = process.env): LicenseEnv {
  const path = licensePath(e);
  return {
    keys: coreLicense.embeddedKeys(),
    watermark: coreLicense.buildWatermark(),
    readFile: () => readLicenseFile(path),
    clock: () => Date.now(),
    mono: () => performance.now(),
  };
}

type EnvGlobal = typeof globalThis & { __crmLicenseEnv?: LicenseEnv; __crmLicenseEnvOverride?: Partial<LicenseEnv> };
const g = globalThis as EnvGlobal;

/** Окружение проверки этого процесса (ключи из сборки читаются один раз); в тестах — с подменой (testing.ts). */
export function licenseEnv(): LicenseEnv {
  g.__crmLicenseEnv ??= defaultLicenseEnv();
  const o = g.__crmLicenseEnvOverride;
  return o ? { ...g.__crmLicenseEnv, ...o } : g.__crmLicenseEnv;
}
