// Данные переключателя для оболочки: null, пока флаг THEME_DARK выключен (переключателя нет).
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { getActiveConfigOrNull } from '@/server/platform/config/active';
import { isFeatureEnabled } from '@/server/platform/flags';
import { parseThemeSettings } from './compute';
import { THEME_COOKIE, effectiveMode } from './mode';
import type { ThemeSwitchProps } from './ThemeSwitch';

export async function loadThemeSwitch(): Promise<Omit<ThemeSwitchProps, 'compact'> | null> {
  if (!isFeatureEnabled('THEME_DARK')) return null;
  const [t, config, jar] = await Promise.all([getTranslations('shell.theme'), getActiveConfigOrNull(), cookies()]);
  const { settings } = parseThemeSettings(config?.global.theme);
  return {
    label: t('label'),
    labels: { light: t('light'), dark: t('dark'), system: t('system') },
    value: effectiveMode(jar.get(THEME_COOKIE)?.value, settings.defaultMode, true),
  };
}
