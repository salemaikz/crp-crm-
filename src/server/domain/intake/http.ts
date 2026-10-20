// HTTP-обработчики ingest/v1 на стандартных Request/Response (без Next): тонкие маршруты в src/app/api/ingest/v1/**
// оборачивают их в publicRoute(). Ошибки — по INTEGRATIONS 5.4: `{ error: { code, message, issues? } }`, без значений полей.
import { config as coreConfig } from '@crm/core';
import { deriveClientIp } from '@/server/platform/http/clientIp';
import { ConfigMissingError } from '@/server/platform/config/active';
import { authenticateKey, IngestAuthError } from './auth';
import { requestHash } from './canonical';
import { demandFor } from './demand';
import { parseEnvelope } from './envelope';
import { isClosedFromOutside } from './gate';
import { IdempotencyConflictError, NotAcceptingError, ingestBatch } from './ingest';
import { intakeSettings, SpaceUnknownError } from './settings';
import type { IngestPrincipal, IngestScope } from './types';

/** Предел тела партии: 2 МБ (INTEGRATIONS 5.1). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const HEADERS = { 'Cache-Control': 'no-store' } as const;

function fail(status: number, code: string, issues?: { path: string; code: string }[], extra: Record<string, string> = {}): Response {
  // message повторяет code: человекочитаемых текстов у машинного API нет, источник ориентируется по code
  const error = issues ? { code, message: code, issues } : { code, message: code };
  return Response.json({ error }, { status, headers: { ...HEADERS, ...extra } });
}

/** Закрытый приём отвечает как несуществующий маршрут: ничем не выдаёт, что он есть. */
const notFound = (): Response => fail(404, 'not_found');

function authFailure(f: IngestAuthError['failure']): Response {
  if (f.code === 'unauthorized') return fail(401, 'unauthorized');
  if (f.code === 'forbidden_scope') return fail(403, 'forbidden_scope');
  return fail(429, 'rate_limited', undefined, { 'Retry-After': String(f.retryAfterSec) });
}

/** Ошибка сервера: в лог только имя и сообщение (detail Postgres содержит значения строк). */
function serverFailure(e: unknown): Response {
  const err = e as { name?: unknown; code?: unknown; message?: unknown } | null;
  console.error('[ingest] ошибка', err?.name, err?.code ?? '', err?.message ?? '');
  if (e instanceof ConfigMissingError || e instanceof coreConfig.ConfigInvalidError || e instanceof SpaceUnknownError) return fail(503, 'unavailable');
  return fail(500, 'internal');
}

type Guarded = { principal: IngestPrincipal } | { response: Response };

async function guard(req: Request, scope: IngestScope): Promise<Guarded> {
  if (isClosedFromOutside(req.headers)) return { response: notFound() };
  try {
    return { principal: await authenticateKey(req.headers.get('authorization'), scope, deriveClientIp(req.headers)) };
  } catch (e) {
    if (e instanceof IngestAuthError) return { response: authFailure(e.failure) };
    throw e;
  }
}

/** Читает тело не больше `max` байт; больше — `null`, остаток потока отбрасывается. */
async function readLimited(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function handleLeads(req: Request): Promise<Response> {
  try {
    const g = await guard(req, 'leads:write');
    if ('response' in g) return g.response;

    if (!/^application\/json\s*(;|$)/i.test(req.headers.get('content-type') ?? '')) return fail(415, 'unsupported_media_type');
    const bytes = await readLimited(req, MAX_BODY_BYTES);
    if (!bytes) return fail(413, 'payload_too_large');
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      return fail(400, 'invalid_json');
    }

    const { space } = await intakeSettings(g.principal);
    const env = parseEnvelope(body, space.intake.maxBatch);
    if (!env.ok) return fail(400, 'validation_failed', env.issues);

    const report = await ingestBatch(g.principal, env.batch, requestHash(body));
    return Response.json(report, { headers: HEADERS });
  } catch (e) {
    if (e instanceof IdempotencyConflictError) return fail(409, 'idempotency_conflict');
    if (e instanceof NotAcceptingError) return fail(423, 'not_accepting');
    return serverFailure(e);
  }
}

export async function handleDemand(req: Request): Promise<Response> {
  try {
    const g = await guard(req, 'leads:demand');
    if ('response' in g) return g.response;
    return Response.json(await demandFor(g.principal), { headers: HEADERS });
  } catch (e) {
    return serverFailure(e);
  }
}
