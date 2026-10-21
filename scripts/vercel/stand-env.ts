// Окружение шагов сборки стенда на Vercel (D-318, docs/ops/VERCEL.md). Вызывает scripts/vercel/build.sh.
//   tsx scripts/vercel/stand-env.ts mode            печатает stand | off; код 1 — просьба о стенде в сборке клиента
//   tsx scripts/vercel/stand-env.ts run -- <команда> выполнить команду в окружении стенда: NODE_ENV=production,
//                                                   выведенные секреты (как у приложения), база для сборки
// Значения секретов и адреса базы не печатаются никогда — только тексты проблем.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { driverDatabaseUrl, isVercelStand, vercelStandOverlay } from '../../src/server/platform/stand/overlay';
import { standRequested } from '../../src/server/platform/stand/origin';

type Env = Record<string, string | undefined>;

/** Водяной знак, который получит ядро этой сборки: build.mjs берёт клиента из CRM_CUSTOMER_ID (по умолчанию unset). */
export function buildCustomer(e: Env): string | null {
  const v = e.CRM_CUSTOMER_ID?.trim();
  return v && v !== 'unset' ? v : null;
}

/** Хост без суффикса пулера Neon (ep-x-pooler.… → ep-x.…) и имя базы: так сравниваются адреса одной базы. */
function dbIdentity(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/-pooler(?=\.)/, '')}/${u.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Адрес базы для миграций и сида: прямой адрес Neon (DATABASE_URL_UNPOOLED, POSTGRES_URL_NON_POOLING), если он
 * ведёт в ту же базу, что и рабочий; иначе рабочий. DDL и сид идут мимо пулера.
 */
export function buildDatabaseUrl(e: Env, runtimeUrl: string): string {
  const direct = e.DATABASE_URL_UNPOOLED?.trim() || e.POSTGRES_URL_NON_POOLING?.trim();
  if (direct && dbIdentity(direct) !== null && dbIdentity(direct) === dbIdentity(runtimeUrl)) return driverDatabaseUrl(direct);
  return runtimeUrl;
}

/** Окружение шага сборки или список проблем. */
export function stepEnv(e: Env): { env: Env } | { problems: string[] } {
  const watermark = { customer: buildCustomer(e) };
  if (!isVercelStand(e, watermark)) return { problems: ['режим стенда на Vercel выключен: нужны VERCEL=1, CRM_STAND=1 и общая сборка'] };
  const { set, problems } = vercelStandOverlay(e);
  if (problems.length > 0) return { problems };
  const env: Env = { ...e, ...set, NODE_ENV: 'production' };
  const db = buildDatabaseUrl(e, env.DATABASE_URL as string);
  env.DATABASE_URL = db;
  env.MIGRATE_DATABASE_URL = db;
  return { env };
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  if (cmd === 'mode') {
    if (standRequested(process.env) && buildCustomer(process.env) !== null) {
      console.error('Ошибка: CRM_STAND=1 в сборке клиента (CRM_CUSTOMER_ID задан). Режим стенда на Vercel — только общая сборка на синтетике (D-318).');
      return 1;
    }
    console.log(isVercelStand(process.env, { customer: buildCustomer(process.env) }) ? 'stand' : 'off');
    return 0;
  }
  if (cmd === 'run' && rest[0] === '--' && rest.length > 1) {
    const r = stepEnv(process.env);
    if ('problems' in r) {
      console.error(`Ошибка: окружение стенда Vercel не годится (docs/ops/VERCEL.md):\n- ${r.problems.join('\n- ')}`);
      return 1;
    }
    const [bin, ...args] = rest.slice(1) as [string, ...string[]];
    const res = spawnSync(bin, args, { env: r.env as NodeJS.ProcessEnv, stdio: 'inherit' });
    if (res.error) {
      console.error(`Ошибка: не запустилась команда ${bin}: ${res.error.message}`);
      return 1;
    }
    return res.status ?? 1;
  }
  console.error('Использование: stand-env.ts mode | run -- <команда> [аргументы]');
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
