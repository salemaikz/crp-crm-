import { route } from '@/server/access';
import { parseBody, pinNoteBody } from '@/server/domain/clients';
import { pinNote } from '@/server/domain/timeline';
import { pathId, readJson } from '../../_support';

// Закрепить или открепить заметку (до трёх закреплённых; четвёртая — 409 `pin_limit`).
export const PATCH = route({ perm: 'note.write', target: 'object' }, async ({ req, params, viewer }) => {
  const id = pathId(params);
  const body = parseBody(pinNoteBody, await readJson(req));
  return pinNote(viewer, id, body.pinned);
});
