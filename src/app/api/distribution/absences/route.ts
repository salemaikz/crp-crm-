// «Отсутствует»: список действующих и будущих отсутствий (`pool.read`) и создание (`distribution.manage`).
// Повтор того же opId возвращает прежнее отсутствие (200), новое — 201. Применение к карточкам — в той же транзакции.
import { route } from '@/server/access';
import { createAbsence, listAbsences } from '@/server/domain/distribution';
import { AbsenceBody, readJson, respond } from '../_lib';

export const GET = route({ perm: 'pool.read' }, ({ viewer }) => respond(() => listAbsences(viewer)));

export const POST = route({ perm: 'distribution.manage' }, ({ req, viewer }) =>
  respond(async () => {
    const body = await readJson(req, AbsenceBody);
    const result = await createAbsence(viewer, body);
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: { 'Cache-Control': 'no-store' } });
  }),
);
