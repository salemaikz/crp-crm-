// Вид «Обзвон» для РОП и директора (B8, PROCESS 4.4; pipeline-v2 §11, линия M1). При OP_BOARD — общий компонент доски
// с охватом пространства и фильтрами; без флага — прежняя доска «Обзвон». Страница с данными: page() с 'card.read'.
// Охват ниже пространства (оператор) — 403 из сервиса; без KANBAN и OP_BOARD — 404 (К5: OP_BOARD работает без KANBAN).
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { notFound } from 'next/navigation';
import { NotFoundError, page } from '@/server/access';
import { getCallingBoard, getCallingWorkers } from '@/server/domain/deals';
import { isFeatureEnabled } from '@/server/platform/flags';
import { loadCallConfig } from '@/app/(op)/call/loadCallConfig';
import { loadBoardConfig } from '@/app/(op)/board/loadBoardConfig';
import { BoardScreen } from '@/ui/board/BoardScreen';
import { PageHeader } from '@/ui/kit';
import { BoardTabs } from '../BoardTabs';
import { CallingBoard } from './CallingBoard';

export default page({ perm: 'card.read', target: 'section' }, async ({ viewer }) => {
  if (isFeatureEnabled('OP_BOARD')) {
    let owners;
    try {
      owners = await getCallingWorkers(viewer);
    } catch (e) {
      if (e instanceof NotFoundError) notFound();
      throw e;
    }
    const config = await loadBoardConfig(viewer);
    if (!config) notFound();
    // Вкладки «Доска» / «Этапы сделок» — только при включённом KANBAN: иначе второй вкладки нет (К5)
    const tabs = isFeatureEnabled('KANBAN') ? <BoardTabs active="calling" showCalling opBoard /> : undefined;
    return (
      <BoardScreen
        config={{ ...config, scope: 'wide', manager: { owners } }}
        userId={viewer.userId}
        header={<BoardHeader tabs={tabs} />}
      />
    );
  }
  let board;
  try {
    board = await getCallingBoard(viewer);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const config = await loadCallConfig(viewer);
  if (!config) notFound();
  return <CallingBoard initial={board} config={config} userId={viewer.userId} />;
});

function BoardHeader({ tabs }: { tabs: ReactNode }) {
  const t = useTranslations('deals.board');
  return <PageHeader title={t('boardTitle')} lead={t('boardLead')} tabs={tabs} />;
}
