// Сверка сессии открытой вкладки (D-292): на возврат, фокус, показ и появление сети страница спрашивает, чья сессия
// у cookie. 200 — того же сотрудника, что и страница (X-Call-Author); 409 `wrong_user` — на телефоне вошёл другой;
// сессии нет — 401 обёртки. Вкладка на 401 и 409 прячется и перезагружается. Ничего не пишет и данных не отдаёт.
import { route } from '@/server/access';

/** Тот же заголовок, что у маршрутов обзвона (D-291): id сотрудника страницы. */
const AUTHOR_HEADER = 'x-call-author';

export const GET = route({ perm: 'authenticated' }, async ({ req, viewer }) => {
  const author = req.headers.get(AUTHOR_HEADER);
  if (author !== null && author !== '' && author !== viewer.userId) {
    return Response.json({ error: 'wrong_user', code: 'wrong_user' }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }
  return { ok: true };
});
