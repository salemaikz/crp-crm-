// Сводка дня РОП (R1a): плитки и таблица операторов. Страница с данными: только через page() с правом 'report.view'
// (охват пространства проверяет сервис: директору та же сводка, только чтение).
import type { ReactNode } from 'react';
import { page } from '@/server/access';
import { getSummary } from '@/server/domain/reports';
import { SummaryScreen } from './SummaryScreen';
import type { SummaryData } from './types';

export default page<unknown, ReactNode>({ perm: 'report.view' }, async ({ viewer }) => {
  // присваивание проверяет, что форма из домена совместима с типами клиентского экрана
  const data: SummaryData = await getSummary(viewer);
  return <SummaryScreen initial={data} />;
});
