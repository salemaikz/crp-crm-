// Шаг `crmctl update`: миграции настроек vN → vN+1 над живой ревизией каждой области (CONFIG §4).
// Результат проверяется схемой набора целиком и пишется НОВОЙ ревизией source=migration; старая
// остаётся для отката (D-060). Ошибка — исключение: выкладка не переключается.
import { CONFIG_SCHEMA_VERSION, GLOBAL_SCOPE, migrateDoc, type ConfigMigration, type Json } from '@crm/core/config';
import { getDb } from '../db';
import { listSpaces, loadCompatible } from './repo';
import { writeConfig, type WriteResult } from './write';

export async function migrateConfigs(opts: { migrations?: readonly ConfigMigration[]; targetVersion?: number; now?: number } = {}): Promise<WriteResult> {
  const target = opts.targetVersion ?? CONFIG_SCHEMA_VERSION;
  const db = await getDb();
  const spaces = await listSpaces(db.sql);
  const docs: { global?: Json; spaces: Record<string, Json> } = { spaces: {} };
  const expectedRev: Record<string, number> = {};
  for (const s of [{ name: GLOBAL_SCOPE, id: GLOBAL_SCOPE, kind: 'global' as const }, ...spaces.map((x) => ({ name: x.key, id: x.id, kind: 'space' as const }))]) {
    const r = await loadCompatible(db.sql, s.id, target);
    if (!r || r.schemaVersion >= target) continue;
    const doc = migrateDoc(s.kind, r.doc as Record<string, Json>, r.schemaVersion, target, opts.migrations);
    expectedRev[s.name] = r.rev;
    if (s.kind === 'global') docs.global = doc;
    else docs.spaces[s.name] = doc;
  }
  if (Object.keys(expectedRev).length === 0) return { written: [], unchanged: [] };
  return writeConfig({
    docs,
    source: 'migration',
    expectedRev,
    note: `schema v${target}`,
    authorId: null,
    schemaVersion: target,
    ...(opts.migrations ? { migrations: opts.migrations } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
}
