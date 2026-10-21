import { route } from '@/server/access';
import { createNoteBody, parseBody } from '@/server/domain/clients';
import { createNote } from '@/server/domain/timeline';
import { pathId, readJson } from '../../_support';

// Новая заметка клиента (C8): `opId` — id заметки, повтор возвращает прежнюю. Заметки не правятся и не удаляются.
export const POST = route({ perm: 'note.write', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const body = parseBody(createNoteBody, await readJson(req));
  return createNote(viewer, id, { opId: body.opId, body: body.body, dealId: body.dealId ?? null });
});
