import { NotFoundError, route } from '@/server/access';
import { bookingDeps, clearException, setException } from '@/server/domain/booking';
import { ExceptionBody, paramId, readJson, requireFeature, respond } from '../../../../_lib';

function dayParam(params: Record<string, string | string[] | undefined>): string {
  const d = params.day;
  if (typeof d !== 'string' || d === '') throw new NotFoundError();
  return d;
}

/** Выходной («off») или особые часы («custom») консультанта на дату. */
export const PUT = route({ perm: 'booking.manage' }, ({ req, params, viewer }) =>
  respond(async () => {
    requireFeature('BK_WIZARD');
    const body = await readJson(req, ExceptionBody);
    return setException(bookingDeps(), viewer, { resourceId: paramId(params), day: dayParam(params), kind: body.kind, windows: body.windows });
  }),
);

/** Убрать исключение: день снова идёт по недельному графику. */
export const DELETE = route({ perm: 'booking.manage' }, ({ params, viewer }) =>
  respond(async () => {
    requireFeature('BK_WIZARD');
    return clearException(bookingDeps(), viewer, { resourceId: paramId(params), day: dayParam(params) });
  }),
);
