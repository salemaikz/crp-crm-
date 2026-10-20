import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getSession } from '@/server/platform/auth';
import { AccountForms } from './AccountForms';

// Только свои данные: гостя отправляем на вход. Обёртка page() P4a заменит эту проверку.
export default async function AccountPage() {
  const session = await getSession();
  if (!session) redirect('/login?next=/account');
  const t = await getTranslations('auth.account');
  return (
    <>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <AccountForms />
    </>
  );
}
