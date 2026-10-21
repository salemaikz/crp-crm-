import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// Ядро в production-сборке (D-028, D-101): `@crm/core` не бандлится, в коде сервера остаётся
// `require('@crm/core')`. Node находит его через ссылку рабочего пространства
// node_modules/@crm/core → packages/core, где `exports` ведёт на обфусцированный dist/index.cjs
// (его собирает packages/core/build.mjs перед next build). В dev и тестах — исходники через paths tsconfig.
// CRM_CORE_BUNDLE=1 — запасной вариант D-028: ядро бандлится из исходников и только минифицируется.
const CORE = '@crm/core';
const coreExternal = process.env.CRM_CORE_BUNDLE !== '1';

type ExternalCtx = { request?: string };
type ExternalCb = (err?: Error | null, result?: string) => void;

function coreExternals(isServer: boolean, nextRuntime: string | undefined) {
  return (ctx: ExternalCtx, cb: ExternalCb) => {
    const req = ctx.request;
    if (req !== CORE && !req?.startsWith(`${CORE}/`)) return cb();
    // dist — один файл: подпути ядра в production не поддерживаются
    if (req !== CORE) return cb(new Error(`${req}: импортируйте ядро только как '${CORE}' (D-101)`));
    // Ядро — только на сервере Node.js: в браузер и edge оно попасть не должно (ARCHITECTURE §2)
    if (!isServer || nextRuntime !== 'nodejs') {
      return cb(new Error(`${CORE} в сборке ${nextRuntime ?? 'client'}: ядро только для сервера Node.js (D-101)`));
    }
    return cb(null, `commonjs ${CORE}`);
  };
}

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Next 16 по умолчанию дописывает правила в AGENTS.md при dev — у нас свои правила
  agentRules: false,
  // Образ клиента без исходников и карт кода (AGENTS.md, ARCHITECTURE §8.2)
  productionBrowserSourceMaps: false,
  // Автономная сборка для Docker (ARCHITECTURE §8.2)
  output: 'standalone',
  // В dev (и в запасном варианте) ядро — исходники TypeScript из packages/core/src
  transpilePackages: [CORE],
  // Трассировка standalone резолвит импорт по paths tsconfig и тянет исходник ядра — исключаем (D-101)
  outputFileTracingExcludes: { '**': ['packages/core/src/**', 'packages/core/build.mjs'] },
  // Стенд на Vercel (D-318): при открытии БД сервер сверяет migrations/*.sql с учётом (assertMigrated), а трассировка
  // этот каталог не видит — путь строится от process.cwd(). В образ его кладёт Dockerfile, поэтому только на Vercel.
  ...(process.env.VERCEL === '1' ? { outputFileTracingIncludes: { '/**': ['./migrations/*.sql'] } } : {}),
  // Признак сборки стенда на Vercel (D-318) вшивается в бандл: '1' ставит только scripts/vercel/build.sh, любая другая
  // сборка получает '0', и переменная при запуске режим стенда уже не включит (src/server/platform/stand/origin.ts)
  env: { CRM_VERCEL_STAND_BUILD: process.env.CRM_VERCEL_STAND_BUILD === '1' ? '1' : '0' },
  // postgres.js не бандлим: нативная загрузка на сервере
  serverExternalPackages: ['postgres'],
  webpack(config, { dev, isServer, nextRuntime }) {
    // Ядро импортирует свои модули с суффиксом .js (ESM в Node и tsx); webpack ищет за ним .ts
    config.resolve.extensionAlias = { ...config.resolve.extensionAlias, '.js': ['.ts', '.tsx', '.js'] };
    if (dev || !coreExternal) return config;
    const prev = config.externals;
    config.externals = [coreExternals(isServer, nextRuntime), ...(Array.isArray(prev) ? prev : prev ? [prev] : [])];
    return config;
  },
};

export default withNextIntl(nextConfig);
