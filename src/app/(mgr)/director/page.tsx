// Панель директора (R4, D-265): только чтение, те же функции отчётов, что у РОП. Страница с данными: только через
// page() с правом 'report.view'; охват пространства проверяет сервис. Кнопок изменения на экране нет.
import type { ReactNode } from 'react';
import { can, page } from '@/server/access';
import { getDirectorDashboard, getReportMeta, parseDirectorWeek } from '@/server/domain/reports';
import { DirectorScreen } from './DirectorScreen';
import type { DirectorData } from './types';

type Props = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

export default page<Props, ReactNode>({ perm: 'report.view' }, async ({ viewer, props }) => {
  // ?week=prev — прошлая неделя целиком (закрытый список, остальное — текущая)
  const sp = (await props.searchParams) ?? {};
  const week = parseDirectorWeek(Array.isArray(sp.week) ? sp.week[0] : sp.week);
  // присваивание проверяет, что форма из домена совместима с типами клиентского экрана
  const data: DirectorData = await getDirectorDashboard(viewer, { week });
  const meta = await getReportMeta(viewer);
  return <DirectorScreen initial={data} labels={meta.labels} canExport={can(viewer, 'report.export')} />;
});
