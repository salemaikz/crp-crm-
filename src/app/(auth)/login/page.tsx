import { getTranslations } from 'next-intl/server';
import { AuthBrand } from '@/ui/shells/AuthBrand';
import { LoginForm } from './LoginForm';

// Данных клиентов не читает: только настройки (логотип, D-333). next берётся из адресной строки в браузере.
export default async function LoginPage() {
  const t = await getTranslations('auth.login');
  return (
    <>
      <AuthBrand />
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <LoginForm />
    </>
  );
}
