// Настройки и секреты подключения Wazzup (INTEGRATIONS §3.2). Ключ API — единственный секрет: хранится
// зашифрованным (integration_secrets), в config его нет.
import { z } from 'zod';

/** Несекретные настройки: источник новых клиентов из входящих (иначе — первый источник вида messenger в настройках). */
export const wazzupConfigSchema = z.object({ sourceKey: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional() }).strict();
export type WazzupConfig = z.infer<typeof wazzupConfigSchema>;

export const wazzupSecretsSchema = z.object({ apiKey: z.string().min(8).max(256) }).strict();
export type WazzupSecrets = z.infer<typeof wazzupSecretsSchema>;

/** Хост API и окна чата: наружу ходим только сюда (INTEGRATIONS §8). */
export const WAZZUP_API_HOST = 'api.wazzup24.com';
export const WAZZUP_API_BASE = `https://${WAZZUP_API_HOST}/v3`;
