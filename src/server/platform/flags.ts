// Флаги модулей — аварийные выключатели (D-047, docs/CONFIG.md §7–8, docs/PLAN.md §7.3).
// Только механизм и список: интеграции дополнительно требуют признак в лицензии и переключатель
// администратора (CONFIG §8) — это добавится вместе с лицензией.
import { isDevOrTest, type Env } from './env';

export type { Env };

export const FEATURES = [
  'BK_WIZARD',
  'PURCHASES',
  'KANBAN',
  'REPORTS_EXPORT',
  'PUSH',
  'MERGE',
  'BULK_TRANSFER',
  'IMPORT',
  // D-295: отчёты за период, их CSV/XLSX и панель директора; настройки продаж в интерфейсе
  'REPORTS',
  'SALES_SETTINGS',
  'WAZZUP',
  'TELEPHONY_ZADARMA',
  'TELEPHONY_BEELINE',
] as const;
export type FeatureName = (typeof FEATURES)[number];

const warned = new Set<string>();

/**
 * FEATURE_<NAME>: '1' — вкл, '0' — выкл. Не задан или пуст: включён только при NODE_ENV development/test,
 * иначе (production, пустое окружение, любое другое значение) выключен — новый модуль не появляется на бою без решения владельца. Стенд
 * работает как production и включает флаги явно в своём env-файле.
 * Другое значение — выкл (fail closed) и одно предупреждение в лог на процесс.
 */
export function isFeatureEnabled(name: FeatureName, env: Env = process.env): boolean {
  const key = `FEATURE_${name}`;
  const raw = env[key]?.trim();
  if (raw === '1') return true;
  if (raw === '0') return false;
  if (raw === undefined || raw === '') return isDevOrTest(env);
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`${key}: допустимы 1 и 0, функция выключена`);
  }
  return false;
}
