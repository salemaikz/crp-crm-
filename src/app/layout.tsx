import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { cookies, headers } from 'next/headers';
import type { CSSProperties, ReactNode } from 'react';
import { getActiveConfigOrNull } from '@/server/platform/config/active';
import { isFeatureEnabled } from '@/server/platform/flags';
import { THEME_COOKIE, ThemeStyle, ToastProvider, htmlThemeAttribute, parseThemeSettings } from '@/ui';
import { LOGOUT_GUARD_SCRIPT } from '@/ui/call/logoutPending';
import { LogoutGuard } from '@/ui/shells/LogoutGuard';
import { fontStackStyle, fontVariableClasses } from './fonts';
import './globals.css';

// Тема и пояс берутся из настроек установки, поэтому страницы рендерятся на запросе, а не на сборке.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('common.app');
  return { title: t('name') };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  // Нет настроек (установка до `crmctl config apply`) — тема по умолчанию; битый набор — ошибка
  const config = await getActiveConfigOrNull();
  // nonce выдаёт прокси при включённом CSP; без него атрибут не ставится
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  // Тёмная тема за флагом (D-342): выбор сотрудника лежит в cookie, иначе вид по умолчанию установки
  const darkEnabled = isFeatureEnabled('THEME_DARK');
  const themeAttr = htmlThemeAttribute((await cookies()).get(THEME_COOKIE)?.value, parseThemeSettings(config?.global.theme).settings.defaultMode, darkEnabled);
  return (
    // suppressHydrationWarning: скрипт выхода может поставить атрибут на <html> до гидратации
    <html lang={locale} data-theme={themeAttr} className={fontVariableClasses} style={fontStackStyle as CSSProperties} suppressHydrationWarning>
      <head>
        {/* Выход не завершён (D-063): страница прячется до первой отрисовки, в том числе оболочка /call из кэша */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: LOGOUT_GUARD_SCRIPT }} />
        <ThemeStyle settings={config?.global.theme} nonce={nonce} darkEnabled={darkEnabled} />
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <LogoutGuard />
          <ToastProvider>{children}</ToastProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
