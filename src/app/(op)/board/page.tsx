import { notFound } from 'next/navigation';
import { page } from '@/server/access';
import { isFeatureEnabled } from '@/server/platform/flags';
import { BoardScreen } from '@/ui/board/BoardScreen';
import { loadBoardConfig } from './loadBoardConfig';

// Главный экран оператора при флаге OP_BOARD: доска из колонок воронки. Страница отдаёт только настройки и права;
// карточки приходят из GET /api/cards/board, охват проверяет сервер в SQL каждого запроса. Флаг выключен — 404.
export default page({ perm: 'card.outcome', target: 'section' }, async ({ viewer }) => {
  if (!isFeatureEnabled('OP_BOARD')) notFound();
  const config = await loadBoardConfig(viewer);
  if (!config) notFound();
  return <BoardScreen config={config} userId={viewer.userId} />;
});
