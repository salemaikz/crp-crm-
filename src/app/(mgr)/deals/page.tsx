// Доска сделок по этапам воронки (B8). Страница с данными: только через page() с правом 'deal.read'.
// Выключена флагом FEATURE_KANBAN (404). Перенос идёт маршрутом сделок (B6), здесь — чтение первой страницы.
import { notFound } from 'next/navigation';
import { NotFoundError, page, scopeOf } from '@/server/access';
import { getDealsBoard } from '@/server/domain/deals';
import { DealsBoard } from './DealsBoard';

export default page({ perm: 'deal.read', target: 'section' }, async ({ viewer }) => {
  let board;
  try {
    board = await getDealsBoard(viewer);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const scope = scopeOf(viewer, 'card.read');
  return <DealsBoard initial={board} timeZone={viewer.timeZone} showCalling={scope === 'space' || scope === 'all'} />;
});
