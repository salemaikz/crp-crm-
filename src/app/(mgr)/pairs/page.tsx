// Экран РОП «Спорные пары» (B9b, PROCESS 7.6): решение по паре и слияние (за FEATURE_MERGE). Страница с данными:
// только через page() с правом 'pool.read'; стороны пары — в охвате зрителя.
import type { ReactNode } from 'react';
import { can, page } from '@/server/access';
import { listPairs } from '@/server/domain/distribution';
import { mergeEnabled } from '@/server/domain/intake';
import { PairsScreen } from './_ui/PairsScreen';
import type { PairsData } from './_ui/types';

export default page<unknown, ReactNode>({ perm: 'pool.read' }, async ({ viewer }) => {
  // присваивание проверяет, что формы из домена совместимы с типами клиентского экрана
  const first = await listPairs(viewer);
  const data: PairsData = {
    items: first.items,
    next: first.next,
    canResolve: can(viewer, 'card.assign'),
    canMerge: mergeEnabled() && can(viewer, 'client.merge'),
    timeZone: viewer.timeZone,
  };
  return <PairsScreen data={data} />;
});
