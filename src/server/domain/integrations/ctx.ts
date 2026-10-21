// Контекст вызова плагина (contract Ctx, дизайн §7.4): настройки по схеме плагина и секреты, которые
// расшифровываются только при вызове ctx.secrets() — открытое значение живёт внутри вызова плагина.
import type { AnyPlugin, Ctx } from '@/integrations/contract';
import { appOrigin } from '@/server/platform/auth/csrf';
import { getDb } from '@/server/platform/db';
import { describeIntegrationSecrets, getIntegrationSecret } from '@/server/platform/secrets';
import type { IntegrationDeps, IntegrationRow } from './types';

/** Настройки подключения не проходят схему плагина: подключение не работает, пока администратор не поправит. */
export class IntegrationConfigError extends Error {
  override name = 'IntegrationConfigError';
  constructor() {
    super('invalid_settings');
  }
}

/** Все секреты подключения по именам → объект для secretsSchema. Без подключения — пустой объект. */
async function readSecrets(integrationId: string | null): Promise<Record<string, string>> {
  if (!integrationId) return {};
  const sql = (await getDb()).sql;
  const out: Record<string, string> = {};
  for (const s of await describeIntegrationSecrets(sql, integrationId)) {
    out[s.name] = await getIntegrationSecret(sql, { integrationId, name: s.name });
  }
  return out;
}

export function buildCtx(deps: IntegrationDeps, plugin: AnyPlugin, row: IntegrationRow | null): Ctx<unknown, unknown> {
  const parsed = plugin.configSchema.safeParse(row?.config ?? {});
  if (!parsed.success) throw new IntegrationConfigError();
  const integrationId = row?.id ?? null;
  return {
    integrationId,
    spaceId: row?.spaceId ?? null,
    config: parsed.data,
    secrets: async () => {
      // Ошибка схемы без значений: ZodError наружу не уходит (в нём могли бы оказаться части секрета)
      const s = plugin.secretsSchema.safeParse(await readSecrets(integrationId));
      if (!s.success) throw new IntegrationConfigError();
      return s.data;
    },
    http: deps.http(plugin.id),
    appOrigin: deps.appOrigin ?? appOrigin() ?? '',
    now: (deps.now ?? Date.now)(),
  };
}
