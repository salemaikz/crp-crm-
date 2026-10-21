import { getTranslations } from 'next-intl/server';
import { page } from '@/server/access';
import { DeviceOwnerGuard } from '@/ui/shells/DeviceOwnerGuard';
import { foreignOutboxTtlMs } from '@/ui/shells/outboxTtl';
import { AccountForms } from './AccountForms';
import { PushToggle } from './PushToggle';

// Только свои данные: гостя обёртка отправляет на вход, чужих прав не нужно.
// Страница вне оболочки, но с сессией: она тоже ставит метку владельца телефона и убирает данные прежнего сотрудника
// (D-292) — после входа через /login?next=/account вкладки прежнего сотрудника прячутся.
export default page({ perm: 'authenticated' }, async ({ viewer }) => {
  const [t, outboxTtlMs] = await Promise.all([getTranslations('auth.account'), foreignOutboxTtlMs()]);
  return (
    <>
      <DeviceOwnerGuard userId={viewer.userId} outboxTtlMs={outboxTtlMs} />
      <h1 className="text-2xl font-semibold">{t('title')}</h1>
      <AccountForms />
      <PushToggle />
    </>
  );
});
