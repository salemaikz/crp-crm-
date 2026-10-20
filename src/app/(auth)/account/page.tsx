import { getTranslations } from 'next-intl/server';
import { page } from '@/server/access';
import { AccountForms } from './AccountForms';

// Только свои данные: гостя обёртка отправляет на вход, чужих прав не нужно.
export default page({ perm: 'authenticated' }, async () => {
  const t = await getTranslations('auth.account');
  return (
    <>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <AccountForms />
    </>
  );
});
