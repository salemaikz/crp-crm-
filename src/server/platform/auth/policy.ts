// Политика безопасности из настроек `global.security` (CONFIG §6.16) — D-091, D-093.
import { z } from 'zod';
import { phone } from '@crm/core';
import { getActiveConfig } from '../config/active';
import { DEFAULT_SECURITY_POLICY, type SecurityPolicy } from './types';

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** Раздел global.security; поля необязательные — недостающие берутся по умолчанию. */
const SecuritySchema = z
  .object({
    sessionDays: int(1, 365).optional(),
    inviteTtlHours: int(1, 720).optional(),
    loginAttempts: z
      .object({ perPhone: int(1, 100).optional(), perIp: int(1, 1000).optional(), windowMin: int(1, 1440).optional() })
      .optional(),
  })
  .passthrough();

/** Раздел global.phone (CONFIG §6.3): правила нормализации номера при входе. */
const PhoneSchema = z
  .object({
    country: z.literal('KZ'),
    mobilePrefixes: z.array(z.string()),
    reviewPrefixes: z.array(z.string()),
    landlinePrefixes: z.array(z.string()),
  })
  .passthrough();

let warned = false;
function warnOnce(msg: string): void {
  if (warned) return;
  warned = true;
  console.warn(`[auth] ${msg}`);
}

/** Только для тестов: снова разрешить предупреждение. */
export function resetPolicyWarning(): void {
  warned = false;
}

/** Раздел `global` активной ревизии или null, если настроек ещё нет (установка до `crmctl config apply`). */
async function loadGlobal(load: () => Promise<unknown>): Promise<Record<string, unknown> | null> {
  try {
    const config = (await load()) as { global?: Record<string, unknown> } | null;
    return config?.global ?? {};
  } catch (e) {
    if (e instanceof Error && e.name === 'ConfigMissingError') return null;
    throw e;
  }
}

/**
 * Правила номеров из `global.phone` активной ревизии. Нет настроек или раздел не прошёл проверку —
 * правила ядра по умолчанию (CONFIG §6.3): вход первого администратора не зависит от настроек.
 */
export async function readPhoneRules(load: () => Promise<unknown> = getActiveConfig): Promise<phone.PhoneRules> {
  const g = await loadGlobal(load);
  if (g === null) return phone.DEFAULT_PHONE_RULES;
  if (g.phone === undefined) return phone.DEFAULT_PHONE_RULES;
  const parsed = PhoneSchema.safeParse(g.phone);
  if (!parsed.success) {
    warnOnce('global.phone не прошёл проверку, действуют правила номеров по умолчанию');
    return phone.DEFAULT_PHONE_RULES;
  }
  const { country, mobilePrefixes, reviewPrefixes, landlinePrefixes } = parsed.data;
  return { country, mobilePrefixes, reviewPrefixes, landlinePrefixes };
}

/**
 * Раздел `global.security` активной ревизии (getActiveConfig, своя схема Zod). Нет настроек
 * (ConfigMissingError — установка до `crmctl config apply`) или раздел не прошёл проверку —
 * DEFAULT_SECURITY_POLICY и одно предупреждение в лог: вход первого администратора не должен
 * зависеть от настроек, а значения по умолчанию безопасны. Прочие сбои чтения пробрасываются.
 */
export async function readSecurityPolicy(load: () => Promise<unknown> = getActiveConfig): Promise<SecurityPolicy> {
  let config: unknown;
  try {
    config = await load();
  } catch (e) {
    if (e instanceof Error && e.name === 'ConfigMissingError') {
      warnOnce('настройки не применены, действует политика безопасности по умолчанию');
      return DEFAULT_SECURITY_POLICY;
    }
    throw e;
  }
  const raw = (config as { global?: { security?: unknown } } | null)?.global?.security;
  if (raw === undefined) return DEFAULT_SECURITY_POLICY;
  const parsed = SecuritySchema.safeParse(raw);
  if (!parsed.success) {
    warnOnce('global.security не прошёл проверку, действует политика по умолчанию');
    return DEFAULT_SECURITY_POLICY;
  }
  const d = DEFAULT_SECURITY_POLICY;
  const v = parsed.data;
  return {
    sessionDays: v.sessionDays ?? d.sessionDays,
    inviteTtlHours: v.inviteTtlHours ?? d.inviteTtlHours,
    loginAttempts: {
      perPhone: v.loginAttempts?.perPhone ?? d.loginAttempts.perPhone,
      perIp: v.loginAttempts?.perIp ?? d.loginAttempts.perIp,
      windowMin: v.loginAttempts?.windowMin ?? d.loginAttempts.windowMin,
    },
  };
}
