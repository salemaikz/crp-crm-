import { getTranslations } from 'next-intl/server';
import { LoginForm } from './LoginForm';

// Статическая: ничего не читает на сервере. next берётся из адресной строки в браузере.
export default async function LoginPage() {
  const t = await getTranslations('auth.login');
  return (
    <>
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <LoginForm />
    </>
  );
}
