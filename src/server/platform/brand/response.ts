// Ответ маршрута GET /api/brand/logo (D-333): заголовки, ETag, 304. Без сессии, лицензии и cookie.
import { getActiveConfigOrNull } from '../config/active';
import { readLogo, type LogoFile } from './logo';

type Env = Record<string, string | undefined>;
export type LogoRouteDeps = {
  logoKey: () => Promise<string | null>;
  env: Env;
};

const defaultDeps = (): LogoRouteDeps => ({
  logoKey: async () => (await getActiveConfigOrNull())?.global.theme.logo ?? null,
  env: process.env,
});

/** SVG, открытый как документ: без скриптов и внешних загрузок, отдельное происхождение. */
const CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** Первое слово If-None-Match без W/ и кавычек; список через запятую. */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(',').some((p) => {
    const v = p.trim();
    return v === '*' || v.replace(/^W\//, '') === etag;
  });
}

function baseHeaders(file: LogoFile, etag: string, immutable: boolean): Headers {
  return new Headers({
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP,
    'Cross-Origin-Resource-Policy': 'same-origin',
    ETag: etag,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
}

export async function logoResponse(req: Request, deps: LogoRouteDeps = defaultDeps()): Promise<Response> {
  const key = await deps.logoKey();
  const file = key ? await readLogo(key, deps.env) : null;
  // тот же ответ, что у обёртки доступа для «нет такого» (платформа не импортирует слой access)
  if (!file) return Response.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const etag = `"${file.hash}"`;
  // ?v влияет только на кэш: выбор файла от него не зависит
  const v = new URL(req.url).searchParams.get('v');
  const headers = baseHeaders(file, etag, v === file.hash);
  if (etagMatches(req.headers.get('If-None-Match'), etag)) return new Response(null, { status: 304, headers });
  headers.set('Content-Type', file.contentType);
  headers.set('Content-Length', String(file.bytes.length));
  return new Response(new Uint8Array(file.bytes), { status: 200, headers });
}
