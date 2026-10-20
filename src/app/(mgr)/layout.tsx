// Общий layout кабинета руководителя и администратора: оболочка с меню. Пункты собираются по
// роли зрителя; страницы раздела добавляют свои пункты здесь же, а не в своих layout.
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { page, type PageContext } from '@/server/access';
import { ManagerShell, type ManagerNavItem } from '@/ui/shells';

export default page({ perm: 'authenticated' }, async ({ viewer, props }: PageContext<{ children: ReactNode }>) => {
  const t = await getTranslations('team.shell');
  const tc = await getTranslations('common.app');
  const nav: ManagerNavItem[] = [];
  // Сотрудники — только администратору установки (страница сама проверяет право)
  if (viewer.isAdmin) nav.push({ href: '/team', label: t('nav.staff') });
  return (
    <ManagerShell brand={tc('name')} navLabel={t('nav.label')} nav={nav} account={{ href: '/account', label: t('account') }}>
      {props.children}
    </ManagerShell>
  );
});
