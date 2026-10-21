// Журнал выгрузок (R3b §2.4, PROCESS 8.6): администратор — вся установка, `export.journal` (директор) — своё
// пространство; остальным 403 (проверяет сервис). ?before=<at>:<id> — следующая страница, 50 строк.
import { z } from 'zod';
import { BadRequestError, route } from '@/server/access';
import { JOURNAL_PAGE, getExportJournal } from '@/server/domain/reports';

const Query = z.object({ before: z.string().max(200).regex(/^\d{1,16}:[A-Za-z0-9_-]{1,64}$/).optional() }).strict();

export const GET = route({ perm: 'authenticated' }, async ({ req, viewer }) => {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) throw new BadRequestError('invalid');
  const raw = parsed.data.before;
  const before = raw ? { at: Number(raw.slice(0, raw.indexOf(':'))), id: raw.slice(raw.indexOf(':') + 1) } : null;
  return getExportJournal(viewer, { before, limit: JOURNAL_PAGE });
});
