// Оболочка зрителя: выбирает вид по роли, подписывает пункты из локали и ставит каркас вокруг страницы.
// Серверный компонент: группы маршрутов (op), (mgr), (consultant), (duty) вызывают его из своих layout.
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import type { Viewer } from '@/server/access';
import { unreadCount } from '@/server/domain/notify';
import { loadThemeSwitch } from '@/ui/theme/loadSwitch';
import { ChannelModesProvider } from '@/ui/channels';
import { loadChannelModes } from '@/ui/channels/loadModes';
import { AppShell } from './AppShell';
import { loadLicenseBanner } from './loadBanner';
import { loadBrand } from './loadBrand';
import { loadMenu } from './loadMenu';
import { foreignOutboxTtlMs } from './outboxTtl';
import { MENU_GROUP, MENU_GROUPS, type ShellKind } from './menu';

type Props = {
  viewer: Viewer;
  /** Принудительная оболочка группы (дежурный); иначе по роли. */
  force?: ShellKind;
  /** Непрочитанные уведомления; не задан — считаются здесь (P8a), чтобы бейдж был во всех группах маршрутов. */
  bellCount?: number;
  children: ReactNode;
};

export async function RoleShell({ viewer, force, bellCount, children }: Props) {
  const [t, menu, unread, modes, outboxTtlMs, brand, banner, themeSwitch] = await Promise.all([
    getTranslations('shell'),
    loadMenu(viewer, force),
    bellCount === undefined ? unreadCount(viewer) : Promise.resolve(bellCount),
    // как звонить и писать (D-268): кнопки «Позвонить» и «WhatsApp» читают режим из контекста
    loadChannelModes(viewer),
    foreignOutboxTtlMs(),
    loadBrand(),
    loadLicenseBanner(viewer),
    loadThemeSwitch(),
  ]);
  const bannerView = banner
    ? {
        tone: banner.tone,
        text: t(`license.${banner.key}`, banner.params),
        // свернуть может администратор; короткую «только просмотр» остальным не прячем
        dismissible: viewer.isAdmin,
        dismissLabel: t('license.dismiss'),
      }
    : null;
  const items = menu.items.map((i) => ({ ...i, label: t(`nav.${i.id}`), group: MENU_GROUP[i.id] }));
  const groups = Object.fromEntries(MENU_GROUPS.map((g) => [g, t(`group.${g}`)])) as Record<(typeof MENU_GROUPS)[number], string>;
  return (
    <AppShell
      variant={menu.shell === 'operator' ? 'bottom' : 'side'}
      brand={brand}
      groups={groups}
      navLabel={t('nav.label')}
      items={items}
      bottomSlots={menu.bottomSlots}
      account={{ href: '/account', label: t('account') }}
      bell={{ href: '/notifications', label: t('bell'), count: unread }}
      more={{ label: t('more'), closeLabel: t('close') }}
      userId={viewer.userId}
      outboxTtlMs={outboxTtlMs}
      banner={bannerView}
      themeSwitch={themeSwitch}
    >
      <ChannelModesProvider modes={modes}>{children}</ChannelModesProvider>
    </AppShell>
  );
}
