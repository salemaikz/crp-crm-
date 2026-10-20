import { route } from '@/server/access';
import { bookingDeps, recordConsultResult } from '@/server/domain/booking';
import { ConsultResultBody, paramId, readJson, requireFeature, respond } from '../../_lib';

/** Итог встречи: заметка, следующий шаг, этап сделки. Только после «Пришёл»; повтор `opId` — тот же ответ. */
export const POST = route({ perm: 'note.write', target: 'object' }, ({ req, params, viewer }) =>
  respond(async () => {
    requireFeature('BK_WIZARD');
    const body = await readJson(req, ConsultResultBody);
    return recordConsultResult(bookingDeps(), viewer, { bookingId: paramId(params), ...body });
  }),
);
