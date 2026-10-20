// Политика безопасности из настроек `global.security` (CONFIG §6.16) — D-091, D-093.
import type { SecurityPolicy } from './types';

/**
 * Раздел `global.security` активной ревизии (getActiveConfig, своя схема Zod). Нет настроек
 * (ConfigMissingError — установка до `crmctl config apply`) или раздел не прошёл проверку —
 * DEFAULT_SECURITY_POLICY и одно предупреждение в лог: вход первого администратора не должен
 * зависеть от настроек, а значения по умолчанию безопасны.
 */
export async function readSecurityPolicy(): Promise<SecurityPolicy> {
  throw new Error('readSecurityPolicy: P3');
}
