// Общий приём вебхуков POST /api/hooks/<pluginId>/<token> (INTEGRATIONS §4, дизайн §7.6). Порядок шагов важен:
// дешёвые отказы раньше чтения тела и БД; подлинность — токен пути (в БД только sha256) + verify() плагина;
// идемпотентность — UNIQUE (integration_id, dedupe_key), повтор отвечает 200 и ничего не пишет.
// В логи — только pluginId и код: без тела, токена и адреса.
import { createHash } from 'node:crypto';
import { PLUGIN_IDS, type InboxItem, type PluginId, type RawRequest, type VerifyResult } from '@/integrations/contract';
import { getDb } from '@/server/platform/db';
import { json, readBodyLimited } from '@/server/platform/http/body';
import { rateLimit } from '@/server/platform/ratelimit';
import { buildCtx, IntegrationConfigError } from './ctx';
import { findHookTarget, insertInboxItems, touchLastEvent } from './repo';
import { defaultFlagOn, usabilityOf } from './service';
import type { IntegrationDeps } from './types';

export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
export const WEBHOOK_MAX_ITEMS = 500;
export const WEBHOOK_RATE_LIMIT = 600;
export const WEBHOOK_RATE_WINDOW_MS = 60_000;
export const LAST_EVENT_STEP_MS = 60_000;
/** Токен — 32 байта CSPRNG (base64url или hex); иное даже не ищем в БД. */
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const DEDUPE_RE = /^[\x21-\x7e]{1,200}$/;
const INBOX_KINDS: ReadonlySet<string> = new Set<InboxItem['kind']>(['message', 'status', 'channel', 'call']);

// Один ответ на все «нет такого»: неизвестный плагин, выключенный флаг, чужой токен, выключенное подключение
const notFound = (): Response => json(404, { error: 'not_found' });
const ok = (): Response => json(200, { ok: true });

const isPluginId = (id: string): id is PluginId => (PLUGIN_IDS as readonly string[]).includes(id);
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

function log(code: string, pluginId: PluginId): void {
  console.warn(JSON.stringify({ level: 'warn', code, pluginId }));
}

function jsonOf(body: Uint8Array): unknown {
  if (body.byteLength === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return undefined;
  }
}

/** Строки split() с допустимым ключом и видом; прочие отбрасываются (ключ без номеров и текстов, ≤ 200). */
function validItems(items: readonly InboxItem[]): InboxItem[] {
  return items.filter((i) => typeof i?.dedupeKey === 'string' && DEDUPE_RE.test(i.dedupeKey) && INBOX_KINDS.has(i.kind));
}

export async function receiveWebhook(deps: IntegrationDeps, input: { pluginId: string; token: string; req: Request }): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const { pluginId, token, req } = input;
  // 1. Плагин известен, принимает вебхуки и его флаг включён
  if (!isPluginId(pluginId)) return notFound();
  const plugin = deps.registry.get(pluginId);
  const hook = plugin?.webhook;
  if (!plugin || !hook) return notFound();
  if (plugin.flag && !(deps.flagOn ?? defaultFlagOn)(plugin.flag)) return notFound();
  if (!TOKEN_RE.test(token)) return notFound();

  // 2. Лимит частоты на токен (по хэшу: сам токен в памяти не хранится)
  const tokenHash = sha256(token);
  const lim = rateLimit(`hook:${tokenHash.slice(0, 16)}`, WEBHOOK_RATE_LIMIT, WEBHOOK_RATE_WINDOW_MS, now);
  if (!lim.ok) {
    const sec = Math.max(1, Math.ceil(lim.retryAfterMs / 1000));
    return json(429, { error: 'rate_limited' }, { 'Retry-After': String(sec) });
  }

  // 3. Тело с пределом
  const body = await readBodyLimited(req, WEBHOOK_MAX_BODY_BYTES);
  if (!body) return json(413, { error: 'payload_too_large' });

  // 4. Подключение по хэшу токена
  const sql = (await getDb()).sql;
  const row = await findHookTarget(sql, plugin.id, tokenHash);
  if (!row) return notFound();

  let ctx;
  try {
    ctx = buildCtx(deps, plugin, row);
  } catch (e) {
    if (!(e instanceof IntegrationConfigError)) throw e;
    log('webhook_invalid_settings', plugin.id);
    return json(503, { error: 'unavailable' });
  }

  // 5. Подлинность. Тест провайдера при подписке — 200 без записи, даже у выключенного подключения (D-270)
  const raw: RawRequest = { method: req.method.toUpperCase(), headers: req.headers, body, json: jsonOf(body) };
  let verdict: VerifyResult;
  try {
    verdict = hook.verify(ctx, raw);
  } catch {
    verdict = { ok: false, code: 'bad_body' };
  }
  if (!verdict.ok) {
    log(`webhook_${verdict.code}`, plugin.id);
    return json(401, { error: 'unauthorized' });
  }
  if (verdict.test) return ok();

  // 6. Выключенное или непригодное подключение — как несуществующее
  if (!row.enabled || !(await usabilityOf(deps, plugin, row)).usable) return notFound();

  // 7. Строки inbox (идемпотентно) и отметка «события идут»
  let items: InboxItem[];
  try {
    items = hook.split(ctx, raw);
  } catch {
    log('webhook_split_failed', plugin.id);
    return json(400, { error: 'bad_request' });
  }
  if (items.length > WEBHOOK_MAX_ITEMS) return json(413, { error: 'payload_too_large' });
  const valid = validItems(items);
  if (valid.length < items.length) log('webhook_items_dropped', plugin.id);
  await insertInboxItems(sql, row.id, valid, now);
  await touchLastEvent(sql, row.id, now, LAST_EVENT_STEP_MS);

  // 8. Ответ и на повтор, и на пустой split
  return ok();
}
