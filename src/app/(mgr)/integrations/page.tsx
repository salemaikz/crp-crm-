// Экран администратора «Интеграции». Страница с данными: только через page() с правом 'admin'.
// Блок провайдера, чей флаг выключен, на экран не попадает (в production Wazzup скрыт до решения владельца).
import { pluginDeps } from '@/integrations/registry';
import { page } from '@/server/access';
import { listIntegrations } from '@/server/domain/integrations';
import { listStaff } from '@/server/domain/team';
import { IntegrationsScreen } from './IntegrationsScreen';
import type { PluginView } from './types';

export default page({ perm: 'admin' }, async ({ viewer }) => {
  // присваивание проверяет, что форма из домена совместима с типами клиентского экрана
  const [plugins, staff]: [PluginView[], Awaited<ReturnType<typeof listStaff>>] = await Promise.all([listIntegrations(viewer, pluginDeps()), listStaff(viewer)]);
  const owners = staff.staff.filter((s) => s.status === 'active').map((s) => ({ id: s.id, name: s.name }));
  return <IntegrationsScreen plugins={plugins.filter((p) => p.flagOn)} owners={owners} timeZone={viewer.timeZone} />;
});
