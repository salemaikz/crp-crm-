// Правка полей карточки обзвона из карточки клиента (C8, docs/tasks-team-design.md §3.2). Порядок: блокировка
// карточки с охватом `card.edit` → версия → проверка значений движком полей → сверка `expect` → запись с ростом
// версии и события `field.changed` {obj:'card'} в одной транзакции. Нет изменений — ни записи, ни событий.
import { fields } from '@crm/core';
import { can, NotFoundError, type Viewer } from '@/server/access';
import { lockCardScoped, readCustom, writeCardCustomBumped } from '@/server/domain/cards/repo';
import { getDb, type Sql } from '@/server/platform/db';
import { fieldViewer, loadClientsConfig, type ClientsConfig } from './config';
import { DetailedConflictError, FieldIssuesError } from './errors';
import type { PatchCardBody } from './input';
import { throwNotFoundOrForbidden } from './repo';
import { appendEvents } from '../timeline/repo';

/** Зритель полей карточки: правка по `card.edit`, а не `client.edit`. */
export function cardFieldViewer(viewer: Viewer, cfg: ClientsConfig): fields.FieldViewer {
  const fv = fieldViewer(viewer, cfg);
  return { ...fv, canEdit: fv.roleKey !== null && !viewer.readOnly && can(viewer, 'card.edit') };
}

export type CardFieldsResult = { version: number; fields: fields.Projection };

export async function updateCardFields(viewer: Viewer, cardId: string, body: PatchCardBody): Promise<CardFieldsResult> {
  if (viewer.spaceId === null) throw new NotFoundError();
  const cfg = await loadClientsConfig(viewer);
  const fv = cardFieldViewer(viewer, cfg);
  const db = await getDb();
  return db.tx(async (sql: Sql) => {
    const row = await lockCardScoped(sql, viewer, cardId, 'card.edit');
    if (!row || row.spaceId !== viewer.spaceId) return throwNotFoundOrForbidden(viewer, sql, 'card', cardId);
    const current = (await readCustom(sql, { cardId, clientId: row.snapshot.clientId })).card;
    if (row.snapshot.version !== body.version) throw new DetailedConflictError('card_changed');
    const v = fields
      .buildFieldValidator({ fields: cfg.fields, object: 'card', mode: 'user', viewer: fv, ctx: { phoneRules: cfg.phoneRules } })
      .validate(body.set.custom, current as fields.CustomValues);
    if (v.errors.length > 0) throw new FieldIssuesError(v.errors);
    for (const [k, exp] of Object.entries(body.expect.custom)) {
      const cur = Object.hasOwn(current, k) ? (current[k] as fields.FieldValue) : null;
      const want = exp === undefined || exp === '' ? null : (exp as fields.FieldValue | null);
      if (!fields.sameValue(cur, want)) throw new DetailedConflictError('card_changed');
    }
    let version = row.snapshot.version;
    if (v.changes.length > 0) {
      if (!(await writeCardCustomBumped(sql, viewer, cardId, v.next, viewer.now))) throw new DetailedConflictError('card_changed');
      version += 1;
      await appendEvents(
        sql,
        viewer,
        v.changes.map((c) => ({
          clientId: row.snapshot.clientId,
          kind: 'field.changed',
          data: { obj: 'card', sys: false, field: c.key, before: c.before, after: c.after },
        })),
      );
    }
    return { version, fields: fields.projectFor(fv, 'card', cfg.fields, v.next as fields.CustomValues) };
  });
}
