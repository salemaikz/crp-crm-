import type { MetadataRoute } from 'next';
import { getTranslations } from 'next-intl/server';
import { getActiveConfigOrNull } from '@/server/platform/config/active';
import { isFeatureEnabled } from '@/server/platform/flags';
import { computeTheme } from '@/ui/theme';

// Манифест для установки на главный экран: название из локали, цвета из темы установки (theme.*), иконки — /icon.
// Данных клиентов нет, сессия не нужна; тема читается на запросе, поэтому сборка не фиксирует цвет.
export const dynamic = 'force-dynamic';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const [t, config] = await Promise.all([getTranslations('common.app'), getActiveConfigOrNull()]);
  const { vars } = computeTheme(config?.global.theme);
  return {
    id: '/',
    name: t('name'),
    short_name: t('name'),
    description: t('tagline'),
    // При OP_BOARD приложение открывается на доске (pipeline-v2 §9.1), иначе на экране «Звонить»
    start_url: isFeatureEnabled('OP_BOARD') ? '/board' : '/call',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    lang: 'ru',
    theme_color: vars['--brand'],
    background_color: vars['--canvas'],
    icons: [
      { src: '/icon/192', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon/512', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}
