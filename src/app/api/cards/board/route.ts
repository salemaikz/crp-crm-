import { route } from '@/server/access';
import { getBoard } from '@/server/domain/cards';
import { parseBoardQuery } from '../_support';

// Доска оператора: первая страница каждой колонки и поиск по своим (pipeline-v2 §2.3). Доступ: card.outcome или обзор
// пространства (директор); остальным и при выключенном OP_BOARD — 404 (проверяет домен). Охват — в SQL каждого запроса.
export const GET = route({ perm: 'card.read', target: 'section' }, async ({ req, viewer }) => getBoard(viewer, parseBoardQuery(new URL(req.url).searchParams)));
