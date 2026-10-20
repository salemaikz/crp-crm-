// Помощники интеграционных тестов настроек.
import { configHash, type Json } from '@crm/core/config';
import { minimalSet } from '@crm/core/config/testing/minimal';
import { newId, type DbHandle } from '../../../src/server/platform/db';
import { jsonParam } from '../../../src/server/platform/db/core';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';

export function seedDocs(): { global: Json; spaces: Record<string, Json> } {
  const s = minimalSet();
  return { global: s.global, spaces: s.spaces };
}

/** Первая установка синтетического набора: пространство sales, ревизия 1 у global и sales. */
export async function install(): Promise<void> {
  resetConfigCache();
  await writeConfig({ docs: seedDocs(), source: 'cli', authorId: null, project: true, note: 'seed' });
}

/** Запись «из другого процесса»: мимо writeConfig и кэша. */
export async function rawInsert(db: DbHandle, scope: string, rev: number, schemaVersion: number, doc: Json): Promise<void> {
  await db.sql`
    INSERT INTO config_revisions (id, scope, rev, schema_version, doc, hash, source, preset_doc, note, author_id, created_at)
    VALUES (${newId()}, ${scope}, ${rev}, ${schemaVersion}, ${jsonParam(doc)}, ${await configHash(doc)}, 'cli', NULL, 'raw', NULL, ${Date.now()})`;
}

export async function countRevs(db: DbHandle, scope?: string): Promise<number> {
  const [r] = scope
    ? await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM config_revisions WHERE scope = ${scope}`
    : await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM config_revisions`;
  return r?.n ?? 0;
}

export async function spaceId(db: DbHandle, key: string): Promise<string> {
  const [r] = await db.sql<{ id: string }>`SELECT id FROM spaces WHERE key = ${key}`;
  if (!r) throw new Error(`нет пространства ${key}`);
  return r.id;
}
