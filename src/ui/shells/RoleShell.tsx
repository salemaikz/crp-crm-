// Оболочка зрителя: выбирает вид по роли, подписывает пункты из локали и ставит каркас вокруг страницы.
// Серверный компонент: группы маршрутов (op), (mgr), (consultant), (duty) вызывают его из своих layout.
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import type { Viewer } from '@/server/access';
import { AppShell } from './AppShell';
import { loadMenu } from './loadMenu';
import type { ShellKind } from './menu';

type Props = {
  viewer: Viewer;
  /** Принудительная оболочка группы (дежурный); иначе по роли. */
  force?: ShellKind;
  /** Непрочитанные уведомления; число даст P8a. */
  bellCount?: number;
  children: ReactNode;
};

export async function RoleShell({ viewer, force, bellCount = 0, children }: Props) {
  const [t, tc, menu] = await Promise.all([getTranslations('shell'), getTranslations('common.app'), loadMenu(viewer, force)]);
  const items = menu.items.map((i) => ({ ...i, label: t(`nav.${i.id}`) }));
  return (
    <AppShell
      variant={menu.shell === 'operator' ? 'bottom' : 'side'}
      brand={tc('name')}
      navLabel={t('nav.label')}
      items={items}
      bottomSlots={menu.bottomSlots}
      account={{ href: '/account', label: t('account') }}
      bell={{ href: '/notifications', label: t('bell'), count: bellCount }}
      more={{ label: t('more'), closeLabel: t('close') }}
    >
      {children}
    </AppShell>
  );
}
