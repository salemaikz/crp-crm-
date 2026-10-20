import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Next 16 по умолчанию дописывает правила в AGENTS.md при dev — у нас свои правила
  agentRules: false,
  // Образ клиента без исходников и карт кода (AGENTS.md, ARCHITECTURE §8.2)
  productionBrowserSourceMaps: false,
  // Автономная сборка для Docker (ARCHITECTURE §8.2)
  output: 'standalone',
  // Ядро лежит в репозитории как исходники TypeScript; способ поставки (внешний пакет, обфускация) решает K0
  transpilePackages: ['@crm/core'],
  // postgres.js не бандлим: нативная загрузка на сервере
  serverExternalPackages: ['postgres'],
};

export default withNextIntl(nextConfig);
