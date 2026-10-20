// Поля шторки итога (`requires.fields[]`, docs/calls-design.md §4.1–4.2): проверка движком полей K2 и запись в
// custom клиента или карточки. Права на поля — роль зрителя; ошибки → 400 `fields` / `field_not_allowed`.
import { fields } from '@crm/core';
import type { Viewer } from '@/server/access';
import { fieldViewer, loadClientsConfig, type ClientsConfig } from '@/server/domain/clients';
import { insertClientEvent, readCustom, writeCardCustom, writeClientCustom } from '@/server/domain/cards/repo';
import type { OutcomeConfig } from '@/server/domain/cards/types';
import type { Sql } from '@/server/platform/db';
import { CallsDomainError } from './errors';

type Obj = 'card' | 'client';

export interface FieldWrite {
  obj: Obj;
  next: Record<string, fields.FieldValue>;
  changes: fields.FieldChange[];
}

/** Ключи ⊆ `requires.fields[]` итога (без обращения к настройкам полей). */
export function assertFieldKeysAllowed(def: OutcomeConfig, patch: Readonly<Record<string, unknown>>): void {
  for (const k of Object.keys(patch)) if (!def.requiredFields.includes(k)) throw new CallsDomainError('field_not_allowed', `fields.${k}`);
}

/** Настройки полей нужны, только если шторка что-то передала или итог требует поля. */
export async function loadFieldsConfig(viewer: Viewer, def: OutcomeConfig, patch: Readonly<Record<string, unknown>>): Promise<ClientsConfig | null> {
  if (def.requiredFields.length === 0 && Object.keys(patch).length === 0) return null;
  return loadClientsConfig(viewer);
}

/**
 * Проверка значений под блокировкой карточки. Возвращает записи по объектам (только реальные изменения)
 * или бросает `fields`. Обязательные поля итога должны быть непустыми после правки.
 */
export async function validateOutcomeFields(
  tx: Sql,
  viewer: Viewer,
  cfg: ClientsConfig,
  def: OutcomeConfig,
  card: { id: string; clientId: string },
  patch: Readonly<Record<string, unknown>>,
  outcomeKey: string,
): Promise<FieldWrite[]> {
  const current = await readCustom(tx, { cardId: card.id, clientId: card.clientId });
  const fv = fieldViewer(viewer, cfg);
  const byObj: Record<Obj, Record<string, unknown>> = { card: {}, client: {} };
  const keyObj = new Map<string, Obj>();
  for (const d of cfg.fields) if ((d.object === 'card' || d.object === 'client') && !keyObj.has(d.key)) keyObj.set(d.key, d.object);
  for (const [k, v] of Object.entries(patch)) {
    const o = keyObj.get(k);
    if (!o) throw new CallsDomainError('fields', `fields.${k}`);
    byObj[o][k] = v;
  }
  // Обязательные поля, которые не пришли, должны быть уже заполнены
  for (const k of def.requiredFields) {
    const o = keyObj.get(k);
    if (!o) throw new CallsDomainError('fields', `fields.${k}`);
    if (!Object.hasOwn(byObj[o], k) && fields.isEmptyValue(((current[o][k] ?? null) as fields.FieldValue | null))) throw new CallsDomainError('fields', `fields.${k}`);
  }
  const out: FieldWrite[] = [];
  for (const obj of ['client', 'card'] as const) {
    if (Object.keys(byObj[obj]).length === 0) continue;
    const v = fields
      .buildFieldValidator({ fields: cfg.fields, object: obj, mode: 'user', viewer: fv, transition: { kind: 'outcome', outcome: outcomeKey }, ctx: { phoneRules: cfg.phoneRules } })
      .validate(byObj[obj], current[obj] as fields.CustomValues);
    const first = v.errors[0];
    if (first) throw new CallsDomainError('fields', `fields.${first.key}`);
    for (const k of def.requiredFields) {
      if (keyObj.get(k) === obj && fields.isEmptyValue(v.next[k] ?? null)) throw new CallsDomainError('fields', `fields.${k}`);
    }
    if (v.changes.length > 0) out.push({ obj, next: v.next, changes: v.changes });
  }
  return out;
}

/** Запись значений и события `field.changed` ленты (после применения итога). */
export async function writeOutcomeFields(tx: Sql, viewer: Viewer, card: { id: string; clientId: string; spaceId: string }, writes: readonly FieldWrite[], at: number): Promise<void> {
  for (const w of writes) {
    const ok = w.obj === 'card' ? await writeCardCustom(tx, viewer, card.id, w.next, at) : await writeClientCustom(tx, viewer, card.clientId, w.next, at);
    if (!ok) throw new CallsDomainError('forbidden');
    for (const c of w.changes) {
      await insertClientEvent(tx, {
        clientId: card.clientId,
        spaceId: card.spaceId,
        kind: 'field.changed',
        actorId: viewer.userId,
        at,
        refType: '',
        refId: '',
        data: { obj: w.obj, sys: false, field: c.key, before: c.before, after: c.after },
      });
    }
  }
}
