// Синтетический плагин с вебхуком для тестов общего приёма и очереди (сеть не используется). id — из PLUGIN_IDS,
// реализация — тестовая: подлинность по заголовку X-Test-Auth, события в теле `{events:[{id, kind}]}`.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AnyPlugin, MessengerPlugin, NormalizedEvent, PluginHttp } from '../../../src/integrations/contract';
import { pluginUsability } from '../../../src/integrations/enablement';
import { createRegistry, PLUGINS } from '../../../src/integrations/registry';
import type { IntegrationDeps } from '../../../src/server/domain/integrations';
import type { Sql } from '../../../src/server/platform/db';
import { jsonParam } from '../../../src/server/platform/db/core';

export const T0 = Date.parse('2026-10-28T06:00:00Z');
export const GOOD = 'good-synthetic-auth';
export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

const noHttp: PluginHttp = {
  fetch: async () => {
    throw new Error('сеть в тестах не используется');
  },
};

const ev = z.object({ id: z.string(), kind: z.enum(['message', 'status']) }).passthrough();

export const fakeMessenger: MessengerPlugin<{ sourceKey?: string }, { apiKey?: string }> = {
  id: 'messenger.wazzup',
  kind: 'messenger',
  version: 1,
  flag: 'WAZZUP',
  licenseFeature: 'messenger.wazzup',
  crossBorder: true,
  needsConnection: true,
  configSchema: z.object({ sourceKey: z.string().optional() }).strict(),
  secretsSchema: z.object({ apiKey: z.string().optional() }).strict(),
  capabilities: { chat: 'iframe', inbound: true, channels: true },
  healthCheck: async () => ({ ok: true, code: 'ok' }),
  openChat: async () => ({ kind: 'error', code: 'not_configured' }),
  webhook: {
    verify: (_ctx, req) => {
      const body = req.json as { test?: unknown } | undefined;
      if (req.method !== 'POST' || typeof body !== 'object' || body === null) return { ok: false, code: 'bad_body' };
      if (body.test === true) return { ok: true, test: true };
      return req.headers.get('x-test-auth') === GOOD ? { ok: true, test: false } : { ok: false, code: 'bad_auth' };
    },
    split: (_ctx, req) => {
      const list = (req.json as { events?: unknown[] }).events ?? [];
      return list.flatMap((e) => {
        const p = ev.safeParse(e);
        return p.success ? [{ dedupeKey: `e:${p.data.id}`, kind: p.data.kind, payload: p.data }] : [];
      });
    },
    parse: (kind, payload): NormalizedEvent[] => {
      const p = ev.safeParse(payload);
      if (!p.success || kind !== 'status') return [];
      return [{ type: 'status', providerMessageId: p.data.id, status: 'delivered', at: T0 }];
    },
  },
};

// Настоящий wazzup из реестра заменён синтетическим плагином с тем же id: сеть и подпись в тестах не нужны
export const fakeRegistry = createRegistry([...PLUGINS.filter((p) => p.id !== fakeMessenger.id), fakeMessenger as unknown as AnyPlugin]);

export function deps(over: Partial<IntegrationDeps> = {}): IntegrationDeps {
  return { registry: fakeRegistry, usability: pluginUsability, http: () => noHttp, flagOn: () => true, licensed: async () => true, appOrigin: 'https://crm.test', now: () => T0, ...over };
}

export async function insertIntegration(
  sql: Sql,
  row: { id: string; pluginId?: string; spaceId?: string | null; enabled?: boolean; approved?: boolean; token?: string | null; config?: unknown },
): Promise<void> {
  const tokenHash = row.token ? sha(row.token) : null;
  await sql`
    INSERT INTO integrations (id, plugin_id, space_id, config, enabled, webhook_token_hash, crossborder_approved_at, created_at, updated_at)
    VALUES (${row.id}, ${row.pluginId ?? 'messenger.wazzup'}, ${row.spaceId ?? null}, ${jsonParam(row.config ?? {})}, ${row.enabled ?? true},
            ${tokenHash}, ${row.approved === false ? null : T0}, ${T0}, ${T0})`;
}

export const tokenOf = (n: number): string => `tok${String(n).padStart(2, '0')}`.padEnd(43, 'x');
