// Общее для маршрутов /api/import: пользователь → ImportActor, разбор тел по Zod, коды ошибок → HTTP.
// Ошибки файла и импорта отдаются кодом без текста (текст — messages/ru/import.json). Ответы no-store.
import { imports } from '@crm/core';
import { z } from 'zod';
import { BadRequestError, NotFoundError, type Viewer } from '@/server/access';
import { ImportError, type ImportActor } from '@/server/domain/import';
import { SpreadsheetError, type SpreadsheetErrorCode } from '@/server/platform/files';

/** Охват импорта — пространство; у пользователя без пространства раздела нет. */
export function actorOf(viewer: Viewer): ImportActor {
  if (viewer.spaceId === null) throw new NotFoundError();
  return { userId: viewer.userId, spaceId: viewer.spaceId, viewer };
}

const FILE_STATUS: Record<SpreadsheetErrorCode, number> = {
  too_large: 413,
  empty: 400,
  bad_type: 415,
  legacy_xls: 415,
  macro: 415,
  unsupported_encoding: 415,
  corrupt: 422,
  zip_limits: 422,
  xml_doctype: 422,
  too_many_rows: 422,
  sheet_required: 422,
  sheet_not_found: 422,
  busy: 429,
};

const IMPORT_STATUS: Record<string, number> = {
  not_found: 404,
  feature_off: 404,
  busy: 409,
  preview_stale: 409,
  blocked: 409,
  rows_expired: 410,
  bad_owner: 400,
  bad_author: 400,
  bad_profile: 400,
  header_not_found: 422,
  stand_unavailable: 409,
};

const json = (status: number, body: unknown): Response => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

/** Выполнить обработчик; ошибки файла и импорта превратить в ответ с кодом, остальное — в обёртку. */
export async function guarded(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SpreadsheetError) {
      return json(FILE_STATUS[e.code], { error: e.code, ...(e.sheets ? { sheets: e.sheets } : {}) });
    }
    if (e instanceof ImportError) {
      const d = e.detail;
      return json(IMPORT_STATUS[e.code] ?? 400, {
        error: e.code,
        ...(d.missing ? { missing: d.missing } : {}),
        ...(d.summary ? { summary: d.summary } : {}),
        ...(d.blockers ? { blockers: d.blockers } : {}),
      });
    }
    throw e;
  }
}

/** Тело JSON ≤ 64 КиБ по строгой схеме. Битый JSON — 400. */
export async function readJson<T>(req: Request, schema: { parse(raw: unknown): T }): Promise<T> {
  const text = await req.text();
  if (text.length > 65_536) throw new BadRequestError('too_large');
  let raw: unknown = {};
  if (text.trim() !== '') {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new BadRequestError('json');
    }
  }
  return schema.parse(raw);
}

const OwnerMap = z.record(z.string().min(1).max(200), z.string().min(1).max(64)).refine((m) => Object.keys(m).length <= 200, 'ownerMap');

/**
 * Карта авторов профиля «Записи»: ярлык → id сотрудника или null («автор неизвестен»). Пределы — из ядра: разбор
 * обрезает ярлык до той же длины, а ярлыков больше предела — блокер `too_many_authors`, а не 400 на каждый запрос.
 */
const AuthorMap = z
  .record(z.string().min(1).max(imports.AUTHOR_LABEL_MAX), z.string().min(1).max(64).nullable())
  .refine((m) => Object.keys(m).length <= imports.AUTHOR_MAP_MAX, 'authorMap');

export const PreviewBody = z.object({ ownerMap: OwnerMap.default({}), authorMap: AuthorMap.optional() }).strict();
export const ApplyBody = z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/), ownerMap: OwnerMap.default({}), authorMap: AuthorMap.optional() }).strict();

export const ROW_FILTERS = [
  'all', 'create', 'merge', 'update_state', 'kept_in_crm', 'skip_same', 'invalid', 'duplicate_in_file', 'stop_list', 'rejected_rule',
  'held', 'dup_pair', 'import_conflict', 'no_working_phone', 'unowned', 'need_review', 'note_flag', 'agreed_without_booking',
  // Профиль «Записи» (D-324): действия строки и группы отчёта
  'changed_in_file', 'unsupported_type', 'client_not_found', 'client_ambiguous', 'past_event', 'no_event',
  'event_cancelled', 'event_ambiguous', 'booking_exists', 'booking_conflict', 'state_conflict', 'event_full',
  'group_errors', 'group_client_not_found', 'group_no_event', 'group_author_unknown', 'group_duplicate', 'group_review',
] as const;

export const RowsQuery = z
  .object({
    filter: z.enum(ROW_FILTERS).default('all'),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export function queryOf(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}

export const UploadQuery = z
  .object({
    profile: z.string().min(1).max(60),
    sheet: z.string().max(200).optional(),
    snapshotDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();

export function idOf(params: Record<string, string | string[] | undefined>): string {
  return z.string().min(1).max(64).parse(params.id);
}
