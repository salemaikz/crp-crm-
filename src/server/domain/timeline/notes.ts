// Заметки клиента (C8, docs/tasks-team-design.md §3.3). Заметка не правится и не удаляется: исправление —
// новая заметка. Можно закрепить и открепить (до PIN_LIMIT). Охват — в repo.ts; порядок: блокировка клиента с
// охватом → проверки → запись и событие ленты в одной транзакции.
import { BadRequestError, ForbiddenError, NotFoundError, type Viewer } from '@/server/access';
import { DetailedConflictError } from '@/server/domain/clients/errors';
import { throwNotFoundOrForbidden } from '@/server/domain/clients/repo';
import { getDb, type Sql } from '@/server/platform/db';
import {
  appendEvents,
  countPinned,
  dealOfClientVisible,
  insertNote,
  lockClientForNote,
  lockNoteClient,
  selectNote,
  setNotePinned,
} from './repo';
import { NOTE_MAX, PIN_LIMIT, type NoteDto } from './types';

export type CreateNoteInput = { opId: string; body: string; dealId?: string | null };

/**
 * Новая заметка. Повтор `opId` того же сотрудника и клиента возвращает прежнюю заметку (без второго события);
 * чужой или иного клиента `opId` — 400 `op_id`. Пустой текст и длиннее NOTE_MAX — 400.
 */
export async function createNote(viewer: Viewer, clientId: string, input: CreateNoteInput): Promise<NoteDto> {
  const body = input.body.trim();
  if (body.length < 1 || body.length > NOTE_MAX) throw new BadRequestError('body');
  const db = await getDb();
  return db.tx(async (sql: Sql) => {
    if (!(await lockClientForNote(sql, viewer, clientId))) return throwNotFoundOrForbidden(viewer, sql, 'client', clientId);
    const dealId = input.dealId ?? null;
    if (dealId !== null && !(await dealOfClientVisible(sql, viewer, clientId, dealId))) throw new BadRequestError('deal');
    const created = await insertNote(sql, viewer, { id: input.opId, clientId, dealId, body });
    const note = await selectNote(sql, viewer, input.opId);
    if (!created) {
      // Повтор своего opId с тем же клиентом — прежняя заметка; иначе id занят чужой записью
      if (!note || note.clientId !== clientId || note.authorId !== viewer.userId) throw new BadRequestError('op_id');
      return strip(note);
    }
    if (!note) throw new NotFoundError();
    await appendEvents(sql, viewer, [{ clientId, kind: 'note.created', refType: 'note', refId: input.opId, dealId, data: { noteId: input.opId } }]);
    return strip(note);
  });
}

function strip(n: NoteDto & { clientId: string; authorId: string | null }): NoteDto {
  return { id: n.id, body: n.body, pinned: n.pinned, dealId: n.dealId, authorName: n.authorName, createdAt: n.createdAt };
}

/** Закрепить/открепить. Четвёртая закреплённая — 409 `pin_limit`; повтор текущего состояния ничего не меняет. */
export async function pinNote(viewer: Viewer, noteId: string, pinned: boolean): Promise<NoteDto> {
  if (viewer.spaceId === null) throw new NotFoundError();
  const spaceId = viewer.spaceId;
  const db = await getDb();
  return db.tx(async (sql: Sql) => {
    const clientId = await lockNoteClient(sql, viewer, noteId);
    if (!clientId) {
      // Видна на чтение, но писать нельзя — 403; иначе заметки «нет»
      throw (await selectNote(sql, viewer, noteId)) ? new ForbiddenError() : new NotFoundError();
    }
    const cur = await selectNote(sql, viewer, noteId);
    if (!cur) throw new NotFoundError();
    if (cur.pinned !== pinned) {
      if (pinned && (await countPinned(sql, clientId, spaceId)) >= PIN_LIMIT) throw new DetailedConflictError('pin_limit');
      if (!(await setNotePinned(sql, viewer, noteId, pinned))) throw new NotFoundError();
    }
    const after = await selectNote(sql, viewer, noteId);
    if (!after) throw new NotFoundError();
    return strip(after);
  });
}
