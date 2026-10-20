import { route } from '@/server/access';
import { callsDeps, submitOutcome } from '@/server/domain/calls';
import { noteDevice, OutcomeBody, readJson, respond, wrongAuthor } from '../_lib';

/** Итог звонка. Идемпотентен по opId: повтор отвечает прежним итогом (`status: duplicate`). */
export const POST = route({ perm: 'card.outcome' }, ({ req, viewer }) =>
  respond(async () => {
    // Автор с устройства не совпал с сессией: ничего не пишем, даже статус устройства (D-291)
    const wrong = wrongAuthor(req, viewer);
    if (wrong) return wrong;
    const body = await readJson(req, OutcomeBody);
    const result = await submitOutcome(callsDeps(), viewer, body);
    await noteDevice(req, viewer);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  }),
);
