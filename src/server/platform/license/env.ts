// Откуда сервер берёт ключи, водяной знак, файл лицензии, часы и монотонное время (D-211, D-306). В production — только из сборки
// ядра и окружения установки; подмена — только в тестах (testing.ts, в production бросает).
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
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
  /** Текст файла лицензии; null — файла нет; бросает — файл есть, но не читается (вердикт по копии в БД). */
  readFile: () => Promise<string | null>;
  clock: () => number;
  /** Монотонное время процесса (performance.now()): переводом системных часов не сдвигается (D-306). */
  mono: () => number;
};

export function licensePath(e: Env = process.env): string {
  return readEnv(e, 'LICENSE_PATH') ?? DEFAULT_LICENSE_PATH;
}

/**
 * Текст файла лицензии; null — файла нет. Прочие сбои (каталог, канал, устройство, нет прав, ошибка ввода-вывода)
 * бросают с кодом ошибки: пересчёт считает такой файл непригодным и берёт вердикт по копии в БД (service.ts, D-290).
 * Открытие без блокировки и проверка «обычный файл» — канал FIFO без писателя не вешает пересчёт и с ним весь доступ.
 */
export async function readLicenseFile(path: string): Promise<string | null> {
  let fh: FileHandle;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return null;
    throw err;
  }
  try {
    if (!(await fh.stat()).isFile()) throw Object.assign(new Error('license file is not a regular file'), { code: 'ENOTREG' });
    // Слишком большой файл обрезается и не пройдёт разбор (malformed), а не подменяется копией из БД
    const buf = Buffer.alloc(MAX_FILE_BYTES);
    let size = 0;
    while (size < MAX_FILE_BYTES) {
      const { bytesRead } = await fh.read(buf, size, MAX_FILE_BYTES - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    return buf.subarray(0, size).toString('utf8');
  } finally {
    await fh.close();
  }
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
