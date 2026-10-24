// Разбор входа API клиентов: тела запросов (Zod, строго), курсоры, фильтры списка.
import { z } from 'zod';
import { BadRequestError } from '@/server/access';
import { CARD_STATES, type CardState } from './types';

const uuid = z.string().uuid();
const record = z.record(z.string(), z.unknown());

const sysCustom = z
  .object({ system: record.optional(), custom: record.optional() })
  .strict();

/** PATCH клиента или контакта: что менять и что клиент видел до правки (D-124). */
export const patchBody = z
  .object({ set: sysCustom, expect: sysCustom })
  .strict()
  .superRefine((b, ctx) => {
    for (const part of ['system', 'custom'] as const) {
      const set = Object.keys(b.set[part] ?? {}).sort();
      const exp = Object.keys(b.expect[part] ?? {}).sort();
      if (set.length !== exp.length || set.some((k, i) => k !== exp[i])) {
        ctx.addIssue({ code: 'custom', path: ['expect', part], message: 'expect должен содержать те же ключи, что set' });
      }
    }
  });
export type PatchBody = z.infer<typeof patchBody>;

/**
 * PATCH полей карточки обзвона (C8): значения и то, что интерфейс видел до правки. Два режима:
 * с версией карточки (форма «Изменить все», любое число полей) и без неё — ровно одно поле (ввод на месте,
 * pipeline-v2 §9.6): тогда версию заменяет сверка `expect`, чтобы итог в очереди устройства не давал 409.
 */
export const patchCardBody = z
  .object({
    version: z.number().int().min(0).optional(),
    set: z.object({ custom: record }).strict(),
    expect: z.object({ custom: record }).strict(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const set = Object.keys(b.set.custom).sort();
    const exp = Object.keys(b.expect.custom).sort();
    if (set.length !== exp.length || set.some((k, i) => k !== exp[i])) {
      ctx.addIssue({ code: 'custom', path: ['expect', 'custom'], message: 'expect должен содержать те же ключи, что set' });
    }
    if (b.version === undefined && set.length !== 1) {
      ctx.addIssue({ code: 'custom', path: ['version'], message: 'без version правится ровно одно поле' });
    }
  });
export type PatchCardBody = z.infer<typeof patchCardBody>;

/** Заметка (C8): `opId` — id заметки, повтор безопасен. */
export const createNoteBody = z
  .object({ opId: uuid, body: z.string().min(1).max(4000), dealId: z.string().min(1).max(100).nullable().optional() })
  .strict();
export const pinNoteBody = z.object({ pinned: z.boolean() }).strict();

export const addPhoneBody = z
  .object({ opId: uuid, phone: z.string().min(1).max(60), contactId: z.string().min(1).max(100).nullable().optional() })
  .strict();
export type AddPhoneBody = z.infer<typeof addPhoneBody>;

/** Ровно одно действие над номером. */
export const patchPhoneBody = z.union([z.object({ working: z.literal(false) }).strict(), z.object({ primary: z.literal(true) }).strict()]);
export type PatchPhoneBody = z.infer<typeof patchPhoneBody>;

export const addContactBody = z.object({ opId: uuid, system: record.default({}), custom: record.default({}) }).strict();
export type AddContactBody = z.infer<typeof addContactBody>;

/** PATCH контакта: правка полей или архив отдельным телом. */
export const patchContactBody = z.union([patchBody, z.object({ archived: z.literal(true) }).strict()]);
export type PatchContactBody = z.infer<typeof patchContactBody>;

export function parseBody<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new BadRequestError('invalid');
  return r.data;
}

// ---------- Курсоры ----------

/** Курсор «(время, id) последней строки»: base64url от `<время>.<id>`. */
export type Cursor = { at: number; id: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.at}.${c.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  if (raw.length > 200 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new BadRequestError('cursor');
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const m = /^(\d{1,16})\.([A-Za-z0-9_-]{1,100})$/.exec(text);
  if (!m) throw new BadRequestError('cursor');
  const at = Number(m[1]);
  if (!Number.isSafeInteger(at)) throw new BadRequestError('cursor');
  return { at, id: m[2]! };
}

/** `limit` ленты: целое 1–20 (превью в шторке доски); без параметра — null (полная страница), иначе 400. */
export function parseFeedLimit(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (!/^\d{1,2}$/.test(raw)) throw new BadRequestError('limit');
  const n = Number(raw);
  if (n < 1 || n > 20) throw new BadRequestError('limit');
  return n;
}

// ---------- Список ----------

export const LIST_LIMIT = 50;
export const SEARCH_LIMIT = 20;

export type ListQuery = {
  q: string;
  states: CardState[] | null;
  /** Фильтры полей: `f.<ключ>=<значение>`; проверка поля и значения — в сервисе. */
  fieldFilters: Array<{ key: string; value: string }>;
  cursor: Cursor | null;
  limit: number | null;
  /** Вид списка (C9): все, «Мои клиенты» (`agreed`/`client` у меня), архив закрытых. */
  view: 'all' | 'mine' | 'archive';
  /** Архив: владелец карточки (фильтр РОП). */
  owner: string | null;
};

const STATE_SET: ReadonlySet<string> = new Set(CARD_STATES);

/** Разбор строки запроса списка (URLSearchParams); мусор — 400. */
export function parseListQuery(sp: URLSearchParams): ListQuery {
  const q = (sp.get('q') ?? '').slice(0, 200);
  const rawStates = sp.getAll('state');
  if (rawStates.some((s) => !STATE_SET.has(s))) throw new BadRequestError('state');
  const fieldFilters: Array<{ key: string; value: string }> = [];
  for (const [name, value] of sp.entries()) {
    if (!name.startsWith('f.')) continue;
    const key = name.slice(2);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 500 || fieldFilters.some((f) => f.key === key)) throw new BadRequestError('field_filter');
    fieldFilters.push({ key, value });
  }
  if (fieldFilters.length > 5) throw new BadRequestError('field_filter');
  let limit: number | null = null;
  const rawLimit = sp.get('limit');
  if (rawLimit !== null) {
    if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1) throw new BadRequestError('limit');
    limit = Math.min(Number(rawLimit), LIST_LIMIT);
  }
  const rawView = sp.get('view') ?? 'all';
  if (rawView !== 'all' && rawView !== 'mine' && rawView !== 'archive') throw new BadRequestError('view');
  const owner = sp.get('owner');
  if (owner !== null && (owner.length === 0 || owner.length > 100 || rawView !== 'archive')) throw new BadRequestError('owner');
  return {
    view: rawView,
    owner,
    q,
    states: rawStates.length ? ([...new Set(rawStates)] as CardState[]) : null,
    fieldFilters,
    cursor: decodeCursor(sp.get('cursor')),
    limit,
  };
}
