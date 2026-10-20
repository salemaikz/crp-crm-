import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import type { CSSProperties, ReactNode } from 'react';
import { getActiveConfigOrNull } from '@/server/platform/config/active';
import { ThemeStyle, ToastProvider } from '@/ui';
import { fontStackStyle, fontVariableClasses } from './fonts';
import './globals.css';

// Тема и пояс берутся из настроек установки, поэтому страницы рендерятся на запросе, а не на сборке.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('common.app');
  return { title: t('name') };
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  // Нет настроек (установка до `crmctl config apply`) — тема по умолчанию; битый набор — ошибка
  const config = await getActiveConfigOrNull();
  // nonce выдаёт прокси при включённом CSP; без него атрибут не ставится
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    <html lang={locale} className={fontVariableClasses} style={fontStackStyle as CSSProperties}>
      <head>
        <ThemeStyle settings={config?.global.theme} nonce={nonce} />
      </head>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ToastProvider>{children}</ToastProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
