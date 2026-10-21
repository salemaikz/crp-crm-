// Экран «Настройки продаж». Видят право settings.sales и администратор; остальным — 404 (сервис отвечает 403).
import { page } from '@/server/access';
import { getSalesSettings } from '@/server/domain/admin';
import { SettingsScreen } from './SettingsScreen';
import type { SalesSettingsView } from './types';

export default page({ perm: 'authenticated' }, async ({ viewer }) => {
  // присваивание проверяет, что форма из домена совместима с типами клиентского экрана
  const data: SalesSettingsView = await getSalesSettings(viewer);
  return <SettingsScreen initial={data} />;
});
