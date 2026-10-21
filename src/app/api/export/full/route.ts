// Полная выгрузка, шаг 2 (R3b §2.5, D-264): POST формы с одноразовым билетом (браузер сам скачивает файл; Origin у
// формы есть — CSRF-проверка обёртки проходит). Билет гасится сразу; нет, просрочен или чужой — 404. Журнал и уведомления
// пишутся до первого байта, затем ZIP уходит потоком. Мутация безопасности D-054: лицензия её не блокирует.
import { BadRequestError, route } from '@/server/access';
import { streamFullExport } from '@/server/domain/reports';
import { exportGuard, fileHeaders } from '../_lib';

/** Билет — из формы (`application/x-www-form-urlencoded`) или JSON `{ticket}`; тело не больше 1 КБ. */
async function ticketOf(req: Request): Promise<string> {
  const text = await req.text();
  if (text.length > 1024) throw new BadRequestError('invalid');
  let ticket: unknown = null;
  if ((req.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      ticket = (JSON.parse(text) as { ticket?: unknown } | null)?.ticket;
    } catch {
      throw new BadRequestError('invalid');
    }
  } else {
    ticket = new URLSearchParams(text).get('ticket');
  }
  if (typeof ticket !== 'string' || ticket === '') throw new BadRequestError('invalid');
  return ticket;
}

export const POST = route({ perm: 'data.export_all', securityMutation: 'data.export_all' }, async ({ req, viewer }) =>
  exportGuard(async () => {
    const { filename, stream } = await streamFullExport(viewer, { ticket: await ticketOf(req) });
    return new Response(stream, { headers: fileHeaders('application/zip', filename) });
  }),
);
