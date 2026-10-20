// Контакты клиента: добавить, править, в архив (5.4). Контакты в search_norm не входят (v1).
import { fields } from '@crm/core';
import { BadRequestError, ConflictError, type Viewer } from '@/server/access';
import { getDb, type Sql } from '@/server/platform/db';
import { appendEvents } from '../timeline/repo';
import { fieldViewer, loadClientsConfig } from './config';
import { toContactDto } from './dto';
import { FieldIssuesError } from './errors';
import type { AddContactBody, PatchBody } from './input';
import {
  archiveContact,
  insertContact,
  lockClientForEdit,
  lockContactForEdit,
  selectContact,
  throwNotFoundOrForbidden,
  updateContact as updateContactRow,
} from './repo';
import { assertExpected, changeEvents } from './service';
import type { ContactDto } from './types';

export async function addContact(viewer: Viewer, clientId: string, body: AddContactBody): Promise<ContactDto> {
  const cfg = await loadClientsConfig(viewer);
  const fv = fieldViewer(viewer, cfg);
  const db = await getDb();
  await db.tx(async (sql: Sql) => {
    const client = await lockClientForEdit(sql, viewer, clientId);
    if (!client) return throwNotFoundOrForbidden(viewer, sql, 'client', clientId);
    const ctx = { phoneRules: cfg.phoneRules };
    const sys = fields.validateSystemPatch({
      object: 'contact',
      patch: body.system,
      current: {},
      can: { identity: false, edit: true },
      ctx,
    });
    const cv = fields.buildFieldValidator({ fields: cfg.fields, object: 'contact', mode: 'user', viewer: fv, ctx }).validate(body.custom, {});
    const issues = [...sys.errors, ...cv.errors];
    const name = typeof sys.columns.name === 'string' ? sys.columns.name : '';
    if (!name && issues.length === 0) issues.push({ key: 'name', code: 'required' });
    if (issues.length > 0) throw new FieldIssuesError(issues);
    const str = (k: string): string => (typeof sys.columns[k] === 'string' ? (sys.columns[k] as string) : '');
    const inserted = await insertContact(sql, viewer, {
      id: body.opId,
      clientId,
      name,
      position: str('position'),
      isDecisionMaker: sys.columns.is_decision_maker === true,
      callHint: str('call_hint'),
      note: str('note'),
      custom: cv.next,
    });
    if (inserted) {
      await appendEvents(sql, viewer, [{ clientId, kind: 'contact.added', refType: 'contact', refId: body.opId, data: { contactId: body.opId } }]);
      return;
    }
    // Повтор того же opId безопасен; чужой контакт с таким id — ошибка запроса
    const existing = await selectContact(sql, viewer, body.opId);
    if (!existing || existing.clientId !== clientId) throw new BadRequestError('op_id');
  });
  const row = await selectContact((await getDb()).sql, viewer, body.opId);
  if (!row) throw new BadRequestError('op_id');
  return toContactDto(row, fv, cfg.fields);
}

export type PatchContactResult = ContactDto | { id: string; archived: true };

/** Правка полей контакта: блокировка, проверка значений, `expect`, запись и события. */
export async function updateContact(viewer: Viewer, id: string, body: PatchBody): Promise<ContactDto> {
  const cfg = await loadClientsConfig(viewer);
  const fv = fieldViewer(viewer, cfg);
  const db = await getDb();
  await db.tx(async (sql: Sql) => {
    const row = await lockContactForEdit(sql, viewer, id);
    if (!row) return throwNotFoundOrForbidden(viewer, sql, 'contact', id);
    const currentSystem: Record<string, unknown> = {
      name: row.name,
      position: row.position,
      is_decision_maker: row.isDecisionMaker,
      call_hint: row.callHint,
      note: row.note,
    };
    const ctx = { phoneRules: cfg.phoneRules };
    const sys = fields.validateSystemPatch({
      object: 'contact',
      patch: body.set.system ?? {},
      current: currentSystem as Record<string, fields.FieldValue>,
      can: { identity: false, edit: true },
      ctx,
    });
    const cv = fields.buildFieldValidator({ fields: cfg.fields, object: 'contact', mode: 'user', viewer: fv, ctx }).validate(
      body.set.custom ?? {},
      row.custom as fields.CustomValues,
    );
    const issues = [...sys.errors, ...cv.errors];
    if (issues.length > 0) throw new FieldIssuesError(issues);
    assertExpected(body, currentSystem, row.custom);
    if (sys.changes.length + cv.changes.length === 0) return;
    const str = (k: string): string | null => (typeof sys.columns[k] === 'string' ? (sys.columns[k] as string) : null);
    const ok = await updateContactRow(
      sql,
      viewer,
      id,
      {
        name: str('name'),
        position: str('position'),
        isDecisionMaker: typeof sys.columns.is_decision_maker === 'boolean' ? sys.columns.is_decision_maker : null,
        callHint: str('call_hint'),
        note: str('note'),
      },
      cv.next,
    );
    if (!ok) throw new ConflictError();
    await appendEvents(sql, viewer, changeEvents('contact', row.clientId, id, sys.changes, cv.changes));
  });
  const fresh = await selectContact(db.sql, viewer, id);
  if (!fresh) throw new ConflictError();
  return toContactDto(fresh, fv, cfg.fields);
}

/** Контакт в архив: остаётся в БД, из карточки уходит. Повтор — 404 (контакта в карточке уже нет). */
export async function archiveContactById(viewer: Viewer, id: string): Promise<{ id: string; archived: true }> {
  const db = await getDb();
  await db.tx(async (sql: Sql) => {
    const row = await lockContactForEdit(sql, viewer, id);
    if (!row) return throwNotFoundOrForbidden(viewer, sql, 'contact', id);
    if (!(await archiveContact(sql, viewer, id))) throw new ConflictError();
    await appendEvents(sql, viewer, [{ clientId: row.clientId, kind: 'contact.archived', refType: 'contact', refId: id, data: { contactId: id } }]);
  });
  return { id, archived: true };
}
