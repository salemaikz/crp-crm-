// Панель директора (R4, D-265): только чтение, те же функции отчётов, что у РОП. Страница с данными: только через
// page() с правом 'report.view'; охват пространства проверяет сервис. Кнопок изменения на экране нет.
import type { ReactNode } from 'react';
import { can, page } from '@/server/access';
import { getDirectorDashboard, getReportMeta } from '@/server/domain/reports';
import { DirectorScreen } from './DirectorScreen';
import type { DirectorData } from './types';

export default page<unknown, ReactNode>({ perm: 'report.view' }, async ({ viewer }) => {
  // присваивание проверяет, что форма из домена совместима с типами клиентского экрана
  const data: DirectorData = await getDirectorDashboard(viewer);
  const meta = await getReportMeta(viewer);
  return <DirectorScreen initial={data} labels={meta.labels} canExport={can(viewer, 'report.export')} />;
});
