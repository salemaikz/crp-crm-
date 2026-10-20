// Оболочка раздела. Когда у потока появится общий (mgr)/layout.tsx, оболочка переедет туда, а пункты
// меню соберёт он; здесь — только то, что нужно экрану «Сотрудники».
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { ManagerShell } from '@/ui/shells';

export default async function TeamLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations('team.shell');
  const tc = await getTranslations('common.app');
  return (
    <ManagerShell
      brand={tc('name')}
      navLabel={t('nav.label')}
      nav={[{ href: '/team', label: t('nav.staff'), current: true }]}
      account={{ href: '/account', label: t('account') }}
    >
      {children}
    </ManagerShell>
  );
}
