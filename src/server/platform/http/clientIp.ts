// IP клиента для лимитов частоты — только из заголовков, которым можно доверять.
// Источник: платформа LMS 2cd8a2b src/lib/auth/clientIp.ts. Чистая функция от заголовков и env — удобно тестировать.
//
// Заголовки прокси читаются только у запроса, пришедшего через nginx установки: X-Proxy-Secret совпал с
// CRM_PROXY_SECRET (D-155, trustedProxy.ts). Иначе — 'unknown': источник лидов из сети crm_ingest ходит
// к приложению напрямую и подделать IP не может.
//   TRUSTED_PROXY_HOPS=N > 0: N-е значение X-Forwarded-For справа (цепочка своих прокси перед nginx).
//   N = 0 (по умолчанию): X-Real-IP, который nginx ставит из $remote_addr.
// Неизвестный IP → 'unknown': лимит «на IP» становится общим ведром, а учётную запись защищает
// отдельный лимит «на аккаунт». Поэтому в production без CRM_PROXY_SECRET приложение не стартует
// (startupConfigProblems из platform/env.ts, src/instrumentation.ts), а TRUST_X_REAL_IP (D-152) больше
// ничего не включает.
// Режим стенда на Vercel (D-318): IP — X-Real-IP или первый адрес X-Forwarded-For. Оба заголовка Vercel ставит на
// краю сам и внешние значения не пропускает (https://vercel.com/docs/headers/request-headers), CRM_PROXY_SECRET не нужен.
import { isIP } from 'node:net';
import { currentBuild, isVercelStand, type StandBuild } from '../stand';
import { classifyRequest, proxySecret } from './trustedProxy';

export const UNKNOWN_IP = 'unknown';

type HeaderGetter = { get(name: string): string | null | undefined };
type Env = Record<string, string | undefined>;

function normalizeIp(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  // [IPv6]:port и IPv4:port → без порта
  const bracket = /^\[([^\]]+)\](?::\d+)?$/.exec(v);
  const ip = bracket ? (bracket[1] as string) : /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v) ? (v.split(':')[0] as string) : v;
  return ip.length <= 45 && isIP(ip) !== 0 ? ip.toLowerCase() : null;
}

/** Число доверенных прокси из TRUSTED_PROXY_HOPS: целое 0..20, иначе 0. */
export function trustedProxyHops(env: Env = process.env): number {
  const raw = env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw || !/^\d{1,2}$/.test(raw)) return 0;
  const n = Number(raw);
  return n <= 20 ? n : 0;
}

/** Источник IP не настроен в production — текст для оператора (отказ запуска, лог); иначе null. Вне production — null. */
export function clientIpConfigProblem(env: Env = process.env, build: StandBuild = currentBuild()): string | null {
  if (env.NODE_ENV !== 'production') return null;
  if (isVercelStand(env, build)) return null;
  if (proxySecret(env)) return null;
  const why = env.CRM_PROXY_SECRET?.trim()
    ? 'CRM_PROXY_SECRET задан, но не того формата (base64url, от 32 символов)'
    : env.TRUST_X_REAL_IP?.trim() === '1'
      ? 'не задан CRM_PROXY_SECRET (TRUST_X_REAL_IP=1 больше не действует, D-155)'
      : 'не задан CRM_PROXY_SECRET';
  return `${why}: без него приложение не отличает запросы nginx от прямых, IP клиента неизвестен, лимиты входа общие для всех — один злоумышленник запирает вход всей компании. Исправление: sudo crmctl update допишет секрет в /etc/crm/app.env и в nginx; без нового пакета — docs/ops/RUNBOOK.md «Обновление»`;
}

const WARN_INTERVAL_MS = 60 * 60_000;
const lastWarnAt = new Map<string, number>();

function warnHourly(kind: string, text: string, nowMs: number): boolean {
  const last = lastWarnAt.get(kind);
  if (last !== undefined && nowMs - last < WARN_INTERVAL_MS) return false;
  lastWarnAt.set(kind, nowMs);
  console.error(`[security] ВНИМАНИЕ: ${text}`);
  return true;
}

/** Предупреждение о ненастроенном источнике IP: не чаще раза в час. true — записано сейчас. */
export function warnClientIpConfig(env: Env = process.env, nowMs: number = Date.now(), build: StandBuild = currentBuild()): boolean {
  const problem = clientIpConfigProblem(env, build);
  return problem ? warnHourly('config', problem, nowMs) : false;
}

const FORGED_TEXT =
  'запрос с меткой прокси (X-Via-Proxy/X-Proxy-Secret) без верного секрета: nginx не передаёт CRM_PROXY_SECRET (sudo crmctl update) или заголовки подделаны в сети crm_ingest. IP такого запроса не используется';

/** Только для тестов: снова разрешить предупреждения. */
export function resetClientIpWarning(): void {
  lastWarnAt.clear();
}

/** IP клиента по доверенной схеме (см. шапку файла) или UNKNOWN_IP. */
export function deriveClientIp(headers: HeaderGetter, env: Env = process.env, nowMs: number = Date.now(), build: StandBuild = currentBuild()): string {
  if (isVercelStand(env, build)) {
    const first = (headers.get('x-forwarded-for') ?? '').split(',')[0];
    return normalizeIp(headers.get('x-real-ip')) ?? normalizeIp(first) ?? UNKNOWN_IP;
  }
  const path = classifyRequest(headers, env, build);
  if (path !== 'proxy') {
    const warned = warnClientIpConfig(env, nowMs, build);
    if (!warned && path === 'forged' && proxySecret(env)) warnHourly('forged', FORGED_TEXT, nowMs);
    return UNKNOWN_IP;
  }
  const hops = trustedProxyHops(env);
  if (hops > 0) {
    const chain = (headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (chain.length < hops) return UNKNOWN_IP;
    return normalizeIp(chain[chain.length - hops]) ?? UNKNOWN_IP;
  }
  return normalizeIp(headers.get('x-real-ip')) ?? UNKNOWN_IP;
}
