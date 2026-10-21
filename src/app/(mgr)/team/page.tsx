// Экран администратора «Сотрудники». Страница с данными: только через page() с правом 'admin'.
import { page } from '@/server/access';
import { listStaff } from '@/server/domain/team';
import { isFeatureEnabled } from '@/server/platform/flags';
import { StaffScreen } from './StaffScreen';
import type { StaffList } from './types';

export default page({ perm: 'admin' }, async ({ viewer }) => {
  // присваивание проверяет, что форма из домена совместима с типами клиентского экрана
  const data: StaffList = await listStaff(viewer);
  return <StaffScreen data={data} bulkEnabled={isFeatureEnabled('BULK_TRANSFER')} />;
});
