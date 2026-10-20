// IP клиента для лимитов частоты — только из заголовков, которым можно доверять.
// Источник: платформа LMS 2cd8a2b src/lib/auth/clientIp.ts. Чистая функция от заголовков и env — удобно тестировать.
//
// TRUSTED_PROXY_HOPS=N (целое, по умолчанию 0) — сколько своих прокси стоит перед приложением.
//   N > 0: берём N-е значение X-Forwarded-For справа (его дописал наш ближайший доверенный
//          прокси; всё левее мог прислать сам клиент). Значений меньше N — IP неизвестен.
//   N = 0: X-Forwarded-For не читаем вовсе; X-Real-IP — только при TRUST_X_REAL_IP=1
//          (прокси сам ставит его и перезаписывает клиентский; nginx установки это делает).
// Неизвестный IP → 'unknown': лимит «на IP» становится общим ведром, а учётную запись
// защищает отдельный лимит «на аккаунт».
// В production источник IP обязан быть настроен (установка за nginx: TRUST_X_REAL_IP=1, CONFIG §7).
// Не настроен — громкое предупреждение в лог не чаще раза в час (D-152): иначе одно ведро на всех,
// и 100 неверных входов за окно запирают вход всей компании.
import { isIP } from 'node:net';

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

/** Источник IP не настроен в production — текст для лога; иначе null. Вне production не проверяется. */
export function clientIpConfigProblem(env: Env = process.env): string | null {
  if (env.NODE_ENV !== 'production') return null;
  if (trustedProxyHops(env) > 0 || env.TRUST_X_REAL_IP?.trim() === '1') return null;
  return 'в production не задан источник IP клиента (TRUST_X_REAL_IP=1 за nginx установки или TRUSTED_PROXY_HOPS, docs/CONFIG.md §7): лимиты входа и приглашений общие для всех — один злоумышленник запирает вход всей компании';
}

const WARN_INTERVAL_MS = 60 * 60_000;
let lastWarnAt: number | null = null;

/** Предупреждение о ненастроенном источнике IP: не чаще раза в час. true — записано сейчас. */
export function warnClientIpConfig(env: Env = process.env, nowMs: number = Date.now()): boolean {
  const problem = clientIpConfigProblem(env);
  if (!problem) return false;
  if (lastWarnAt !== null && nowMs - lastWarnAt < WARN_INTERVAL_MS) return false;
  lastWarnAt = nowMs;
  console.error(`[security] ВНИМАНИЕ: ${problem}`);
  return true;
}

/** Только для тестов: снова разрешить предупреждение. */
export function resetClientIpWarning(): void {
  lastWarnAt = null;
}

/** IP клиента по доверенной схеме (см. шапку файла) или UNKNOWN_IP. */
export function deriveClientIp(headers: HeaderGetter, env: Env = process.env): string {
  const hops = trustedProxyHops(env);
  if (hops > 0) {
    const chain = (headers.get('x-forwarded-for') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (chain.length < hops) return UNKNOWN_IP;
    return normalizeIp(chain[chain.length - hops]) ?? UNKNOWN_IP;
  }
  if (env.TRUST_X_REAL_IP?.trim() === '1') return normalizeIp(headers.get('x-real-ip')) ?? UNKNOWN_IP;
  warnClientIpConfig(env);
  return UNKNOWN_IP;
}
