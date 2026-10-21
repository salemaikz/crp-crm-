// Доверенный прокси по секрету (D-155). Порт приложения открыт не только nginx: источник лидов из сети
// Docker crm_ingest ходит на http://crm-app:3000 напрямую и может прислать любые заголовки. Поэтому
// заголовки, которые ставит nginx (X-Real-IP, X-Forwarded-For, X-Via-Proxy), принимаются только вместе с
// X-Proxy-Secret, равным CRM_PROXY_SECRET из app.env. nginx берёт секрет из /etc/crm/nginx-proxy.d/
// (пишет crmctl install/update), клиентский X-Proxy-Secret затирается своим proxy_set_header.
//
// Режим стенда на Vercel (D-318): nginx и сети crm_ingest нет, каждый запрос приходит с края Vercel, который сам
// перезаписывает X-Forwarded-For и X-Real-IP (https://vercel.com/docs/headers/request-headers). Там любой запрос —
// 'proxy' (внешний), секрет не нужен; вне режима правила выше не меняются.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Watermark } from '@crm/core/license';
import { buildWatermark, isVercelStand } from '../stand';

type HeaderGetter = { get(name: string): string | null | undefined };
type Env = Record<string, string | undefined>;

export const PROXY_SECRET_HEADER = 'x-proxy-secret';
export const VIA_PROXY_HEADER = 'x-via-proxy';

/** Формат секрета: base64url без '=', от 32 символов (генератор даёт 43). Безопасен для app.env и nginx. */
export const PROXY_SECRET_RE = /^[A-Za-z0-9_-]{32,256}$/;

/** Действующий секрет из CRM_PROXY_SECRET или null (не задан или не того формата — fail closed). */
export function proxySecret(env: Env = process.env): string | null {
  const v = env.CRM_PROXY_SECRET?.trim();
  return v && PROXY_SECRET_RE.test(v) ? v : null;
}

/** Сравнение за постоянное время, в том числе при разной длине: сравниваются SHA-256 обеих строк. */
export function secretsEqual(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Откуда пришёл запрос:
 * - 'proxy'  — через nginx установки: X-Proxy-Secret совпал с CRM_PROXY_SECRET;
 * - 'direct' — мимо nginx (источник лидов из crm_ingest, проверка здоровья по loopback): меток прокси нет;
 * - 'forged' — метка прокси (X-Via-Proxy или X-Proxy-Secret) есть, а верного секрета нет: подделка
 *   или nginx не передаёт секрет. Такому запросу не доверяют ни как внешнему, ни как внутреннему.
 */
export type RequestPath = 'proxy' | 'direct' | 'forged';

export function classifyRequest(headers: HeaderGetter, env: Env = process.env, watermark: Pick<Watermark, 'customer'> = buildWatermark()): RequestPath {
  if (isVercelStand(env, watermark)) return 'proxy';
  const presented = headers.get(PROXY_SECRET_HEADER);
  const secret = proxySecret(env);
  if (secret && presented && secretsEqual(presented, secret)) return 'proxy';
  if (presented != null || headers.get(VIA_PROXY_HEADER) != null) return 'forged';
  return 'direct';
}

/**
 * Пускать ли запрос на /api/ingest/ (второй рубеж за nginx, INTEGRATIONS §5.1): внутренний источник
 * ('direct') — да; через nginx — только при INGEST_PUBLIC=1; поддельная метка — нет никогда.
 */
export function ingestReachable(headers: HeaderGetter, env: Env = process.env, watermark: Pick<Watermark, 'customer'> = buildWatermark()): boolean {
  const path = classifyRequest(headers, env, watermark);
  if (path === 'direct') return true;
  if (path === 'proxy') return env.INGEST_PUBLIC?.trim() === '1';
  return false;
}
