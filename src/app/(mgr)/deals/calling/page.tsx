// Вид «Обзвон» для РОП (B8, PROCESS 4.4): карточки с владельцем по состояниям. Страница с данными: page() с 'card.read'.
// Охват ниже пространства (оператор) — 403 из сервиса; флаг FEATURE_KANBAN выключен — 404.
import { notFound } from 'next/navigation';
import { NotFoundError, page } from '@/server/access';
import { getCallingBoard } from '@/server/domain/deals';
import { loadCallConfig } from '@/app/(op)/call/loadCallConfig';
import { CallingBoard } from './CallingBoard';

export default page({ perm: 'card.read', target: 'section' }, async ({ viewer }) => {
  let board;
  try {
    board = await getCallingBoard(viewer);
  } catch (e) {
    if (e instanceof NotFoundError) notFound();
    throw e;
  }
  const config = await loadCallConfig(viewer);
  if (!config) notFound();
  return <CallingBoard initial={board} config={config} />;
});
