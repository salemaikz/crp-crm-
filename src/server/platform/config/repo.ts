// SQL настроек: ревизии (config_revisions), пространства и команды-проекции. Платформа без домена
// (D-011): SQL лежит здесь. UPDATE/DELETE по config_revisions нет и быть не может (D-068).
import type { ConfigRevision, Json, RevisionSource } from '@crm/core/config';
import { newId, type Sql } from '../db';
import { jsonParam } from '../db/core';

type RevRowDb = Omit<ConfigRevision, 'doc' | 'presetDoc'> & { doc: Json; presetDoc: Json | null };


/** Головы областей: максимальная совместимая rev по каждой (дешёвая проверка кэша). */
export async function listHeads(sql: Sql, supported: number): Promise<Map<string, number>> {
  const rows = await sql<{ scope: string; rev: number }>`
    SELECT scope, max(rev)::int AS rev FROM config_revisions WHERE schema_version <= ${supported} GROUP BY scope`;
  return new Map(rows.map((r) => [r.scope, r.rev]));
}

/** Последняя совместимая ревизия области (индекс config_revisions_compat_idx). */
export async function loadCompatible(sql: Sql, scope: string, supported: number): Promise<ConfigRevision | undefined> {
  const [row] = await sql<RevRowDb>`
    SELECT id, scope, rev, schema_version, doc, hash, source, preset_doc, note, author_id, created_at
      FROM config_revisions WHERE scope = ${scope} AND schema_version <= ${supported}
     ORDER BY rev DESC LIMIT 1`;
  return row;
}

export async function loadRevision(sql: Sql, scope: string, rev: number): Promise<ConfigRevision | undefined> {
  const [row] = await sql<RevRowDb>`
    SELECT id, scope, rev, schema_version, doc, hash, source, preset_doc, note, author_id, created_at
      FROM config_revisions WHERE scope = ${scope} AND rev = ${rev}`;
  return row;
}

export type RevisionHeadRow = { rev: number; schemaVersion: number; source: RevisionSource; presetDoc: Json | null };

/** Ревизии области без тела документа: для nextRev; preset_doc читается для lastPresetDoc. */
export async function listRevisionHeads(sql: Sql, scope: string): Promise<RevisionHeadRow[]> {
  return sql<RevisionHeadRow>`
    SELECT rev, schema_version, source, preset_doc FROM config_revisions WHERE scope = ${scope} ORDER BY rev`;
}

export type NewRevision = {
  scope: string;
  rev: number;
  schemaVersion: number;
  doc: Json;
  hash: string;
  source: RevisionSource;
  presetDoc: Json | null;
  note: string;
  authorId: string | null;
  now: number;
};

export async function insertRevision(sql: Sql, r: NewRevision): Promise<ConfigRevision> {
  const [row] = await sql<RevRowDb>`
    INSERT INTO config_revisions (id, scope, rev, schema_version, doc, hash, source, preset_doc, note, author_id, created_at)
    VALUES (${newId()}, ${r.scope}, ${r.rev}, ${r.schemaVersion}, ${jsonParam(r.doc)}, ${r.hash}, ${r.source},
            ${r.presetDoc === null ? null : jsonParam(r.presetDoc)}, ${r.note}, ${r.authorId}, ${r.now})
    RETURNING id, scope, rev, schema_version, doc, hash, source, preset_doc, note, author_id, created_at`;
  if (!row) throw new Error('insertRevision: строка не вернулась');
  return row;
}

export type SpaceRow = { id: string; key: string; isDefault: boolean; enabled: boolean };

export async function listSpaces(sql: Sql): Promise<SpaceRow[]> {
  return sql<SpaceRow>`SELECT id, key, is_default, enabled FROM spaces ORDER BY key`;
}

// Проекции настроек в таблицы (только apply, CONFIG §2.4): источник правды — настройки.

/** Пространство по ключу: создать, если нет (id — UUID). Возвращает id. */
export async function ensureSpace(sql: Sql, key: string, now: number): Promise<string> {
  await sql`INSERT INTO spaces (id, key, created_at) VALUES (${newId()}, ${key}, ${now}) ON CONFLICT (key) DO NOTHING`;
  const [row] = await sql<{ id: string }>`SELECT id FROM spaces WHERE key = ${key}`;
  if (!row) throw new Error(`ensureSpace: нет пространства «${key}»`);
  return row.id;
}

/** enabled/is_default из настроек. Сначала снимаем признак «по умолчанию», потом ставим (частичный уникальный индекс). */
export async function syncSpaceFlags(sql: Sql, spaces: { key: string; enabled: boolean; default: boolean }[]): Promise<void> {
  const defaultKey = spaces.find((s) => s.default)?.key ?? null;
  await sql`UPDATE spaces SET is_default = FALSE WHERE is_default AND key IS DISTINCT FROM ${defaultKey}`;
  for (const s of spaces) {
    await sql`UPDATE spaces SET enabled = ${s.enabled}, is_default = ${s.default} WHERE key = ${s.key}`;
  }
}

export async function ensureTeam(sql: Sql, spaceId: string, key: string, archived: boolean, now: number): Promise<void> {
  await sql`
    INSERT INTO teams (id, space_id, key, archived_at, created_at)
    VALUES (${newId()}, ${spaceId}, ${key}, ${archived ? now : null}, ${now})
    ON CONFLICT (space_id, key) DO NOTHING`;
  if (archived) await sql`UPDATE teams SET archived_at = ${now} WHERE space_id = ${spaceId} AND key = ${key} AND archived_at IS NULL`;
}

export type SeedSeries = { eventTypeKey: string; weekday: number; startTime: string; durationMin: number; location: string; format: string; capacity: number };

/** Стартовые серии — только если в пространстве ещё нет ни одной (CONFIG §6.9). Возвращает число созданных. */
export async function seedSeriesIfEmpty(sql: Sql, spaceId: string, series: SeedSeries[], now: number): Promise<number> {
  if (series.length === 0) return 0;
  const [cnt] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM event_series WHERE space_id = ${spaceId}`;
  if ((cnt?.n ?? 0) > 0) return 0;
  for (const s of series) {
    await sql`
      INSERT INTO event_series (id, space_id, event_type_key, weekday, start_time, duration_min, location, format, capacity, active, created_at, updated_at)
      VALUES (${newId()}, ${spaceId}, ${s.eventTypeKey}, ${s.weekday}, ${s.startTime}, ${s.durationMin}, ${s.location}, ${s.format}, ${s.capacity}, TRUE, ${now}, ${now})`;
  }
  return series.length;
}

