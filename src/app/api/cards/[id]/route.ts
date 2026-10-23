import { BadRequestError, route } from '@/server/access';
import { FieldConflictError, parseBody, patchCardBody, updateCardFields } from '@/server/domain/clients';
import { isFeatureEnabled } from '@/server/platform/flags';
import { pathId, readJson, withFieldIssues } from '../../clients/_support';

// Правка полей карточки обзвона (C8). Два режима тела (pipeline-v2 §9.6):
// - с `version` (любое число полей): устаревшая версия или расхождение `expect` — 409 `card_changed`;
// - без `version`, ровно одно поле (ввод на месте): сверяется только `expect`; расхождение — 409 с текущим
//   значением этого поля `{key, current}`, чтобы интерфейс показал его, не перечитывая карточку.
export const PATCH = route({ perm: 'card.edit', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const body = parseBody(patchCardBody, await readJson(req));
  // Режим «одно поле» — часть воронки v2: при выключенном CALLBACK_V2 принимается только тело с версией, как раньше
  if (body.version === undefined && !isFeatureEnabled('CALLBACK_V2')) throw new BadRequestError('invalid');
  try {
    return await withFieldIssues(() => updateCardFields(viewer, id, body));
  } catch (e) {
    if (e instanceof FieldConflictError) {
      return Response.json(
        { error: 'conflict', detail: e.detail, key: e.key, current: e.current },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    throw e;
  }
});
