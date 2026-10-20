import { route } from '@/server/access';
import { parseBody, patchCardBody, updateCardFields } from '@/server/domain/clients';
import { pathId, readJson, withFieldIssues } from '../../clients/_support';

// Правка полей карточки обзвона (C8): версия карточки + `set`/`expect` по полям объекта card.
// Устаревшая версия или расхождение `expect` — 409 `card_changed`.
export const PATCH = route({ perm: 'card.edit', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const body = parseBody(patchCardBody, await readJson(req));
  return withFieldIssues(() => updateCardFields(viewer, id, body));
});
