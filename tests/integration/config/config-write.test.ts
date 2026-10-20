// Платформа настроек на Postgres: совместимая ревизия, кэш, single-flight, expectedRev, запись, хэш,
// откат версии, миграции настроек, права журнала.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CONFIG_SCHEMA_VERSION, ConfigInvalidError, configHash, type ConfigMigration, type JsonObject } from '@crm/core/config';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { configCacheStats, ConfigMissingError, getActiveConfig, resetConfigCache } from '../../../src/server/platform/config/active';
import { migrateConfigs } from '../../../src/server/platform/config/migrate';
import { ConfigConflictError, writeConfig } from '../../../src/server/platform/config/write';
import { countRevs, install, rawInsert, seedDocs, spaceId } from './helpers';

let db: TestDb;
before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
});

const BASE = 1_000_000;

function withTimezone(doc: unknown, tz: string): JsonObject {
  const d = structuredClone(doc) as JsonObject;
  (d.org as JsonObject).timezone = tz;
  return d;
}

test('нет ревизий: getActiveConfig бросает ConfigMissingError', async () => {
  resetConfigCache();
  await assert.rejects(getActiveConfig({ now: BASE }), ConfigMissingError);
});

test('первая запись: ревизии 1 у global и sales, проекция пространства, аудит без документа', async () => {
  await install();
  const cfg = await getActiveConfig({ now: BASE });
  assert.equal(cfg.global.rev, 1);
  assert.equal(cfg.spaces.sales?.rev, 1);
  assert.equal(cfg.schemaVersion, CONFIG_SCHEMA_VERSION);
  const [sp] = await db.sql<{ isDefault: boolean; enabled: boolean }>`SELECT is_default, enabled FROM spaces WHERE key = 'sales'`;
  assert.deepEqual(sp, { isDefault: true, enabled: true });
  const audit = await db.sql<{ action: string; meta: Record<string, unknown> }>`SELECT action, meta FROM audit_log WHERE entity = 'config' ORDER BY created_at, id`;
  assert.equal(audit.length, 2);
  assert.ok(audit.every((a) => a.action === 'config.write'));
  for (const a of audit) assert.deepEqual(Object.keys(a.meta).sort(), ['hash', 'rev', 'scope', 'source']);
});

test('D-060: ревизия новой схемы не читается, новая запись получает следующий номер', async () => {
  const before = await getActiveConfig({ now: BASE + 10_000 });
  const rev = before.global.rev;
  await rawInsert(db, 'global', rev + 1, CONFIG_SCHEMA_VERSION + 1, { totally: 'new schema' });
  resetConfigCache();
  const cfg = await getActiveConfig({ now: BASE + 20_000 });
  assert.equal(cfg.global.rev, rev, 'читается совместимая ревизия, а не последняя');
  const res = await writeConfig({ docs: { global: withTimezone(cfg.global.doc, 'Asia/Almaty') }, source: 'cli', authorId: null });
  assert.equal(res.written[0]?.rev, rev + 2);
  const [row] = await db.sql<{ schemaVersion: number }>`SELECT schema_version FROM config_revisions WHERE scope = 'global' AND rev = ${rev + 2}`;
  assert.equal(row?.schemaVersion, CONFIG_SCHEMA_VERSION);
  resetConfigCache();
  assert.equal((await getActiveConfig({ now: BASE + 30_000 })).global.rev, rev + 2);
});

test('кэш: в пределах 5 с запросов нет; чужая запись видна после 5 с; своя — сразу', async () => {
  resetConfigCache();
  const t0 = BASE + 100_000;
  const first = await getActiveConfig({ now: t0 });
  assert.deepEqual(configCacheStats(), { headChecks: 0, reloads: 1 });
  assert.equal(await getActiveConfig({ now: t0 + 1000 }), first, 'тот же объект, без запросов');
  assert.deepEqual(configCacheStats(), { headChecks: 0, reloads: 1 });

  // «другой процесс» пишет мимо кэша
  const next = first.global.rev + 10;
  await rawInsert(db, 'global', next, CONFIG_SCHEMA_VERSION, withTimezone(first.global.doc, 'Asia/Aqtau'));
  assert.equal((await getActiveConfig({ now: t0 + 4999 })).global.rev, first.global.rev, 'до 5 с старая ревизия');
  const later = await getActiveConfig({ now: t0 + 5000 });
  assert.equal(later.global.rev, next);
  assert.equal(later.global.doc.org.timezone, 'Asia/Aqtau');
  assert.deepEqual(configCacheStats(), { headChecks: 1, reloads: 2 });

  // совпавшие головы: только проверка, без перечитывания
  await getActiveConfig({ now: t0 + 10_001 });
  assert.deepEqual(configCacheStats(), { headChecks: 2, reloads: 2 });

  // своя запись — следующий вызов сразу видит
  await writeConfig({ docs: { global: withTimezone(later.global.doc, 'Asia/Oral') }, source: 'cli', authorId: null });
  const mine = await getActiveConfig({ now: t0 + 10_002 });
  assert.equal(mine.global.doc.org.timezone, 'Asia/Oral');
});

test('single-flight: 10 параллельных вызовов на холодном кэше — одно перечитывание', async () => {
  resetConfigCache();
  const all = await Promise.all(Array.from({ length: 10 }, () => getActiveConfig({ now: BASE + 500_000 })));
  assert.equal(configCacheStats().reloads, 1);
  assert.ok(all.every((x) => x === all[0]));
});

test('expectedRev: устаревший — ConfigConflictError; две параллельные записи — одна проходит, вторая 409', async () => {
  resetConfigCache();
  const cfg = await getActiveConfig({ now: BASE + 600_000 });
  const rev = cfg.global.rev;
  await assert.rejects(
    writeConfig({ docs: { global: withTimezone(cfg.global.doc, 'Asia/Qostanay') }, source: 'ui', expectedRev: { global: rev - 1 }, authorId: null }),
    ConfigConflictError,
  );
  const mk = (tz: string) => writeConfig({ docs: { global: withTimezone(cfg.global.doc, tz) }, source: 'ui', expectedRev: { global: rev }, authorId: null });
  const results = await Promise.allSettled([mk('Asia/Atyrau'), mk('Asia/Aqtobe')]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const bad = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(bad.length, 1);
  assert.ok((bad[0] as PromiseRejectedResult).reason instanceof ConfigConflictError);
});

test('неверный документ не пишется: ревизий не прибавилось', async () => {
  resetConfigCache();
  const cfg = await getActiveConfig({ now: BASE + 700_000 });
  const total = await countRevs(db);
  const broken = structuredClone(cfg.global.doc) as unknown as JsonObject;
  (broken.team as JsonObject).fallbackOwnerRole = 'no_such_role';
  await assert.rejects(writeConfig({ docs: { global: broken }, source: 'cli', authorId: null }), (e: unknown) => e instanceof ConfigInvalidError && e.issues.some((i) => /нет роли/.test(i.message)));
  assert.equal(await countRevs(db), total);
});

test('неверный документ пространства из-за связи с global не пишется', async () => {
  const cfg = await getActiveConfig({ now: BASE + 710_000 });
  const total = await countRevs(db);
  const sp = structuredClone(cfg.spaces.sales!.doc) as unknown as JsonObject;
  (sp.distribution as JsonObject).participantRoles = ['ghost'];
  await assert.rejects(writeConfig({ docs: { spaces: { sales: sp } }, source: 'cli', authorId: null }), ConfigInvalidError);
  await assert.rejects(writeConfig({ docs: { spaces: { nowhere: sp } }, source: 'cli', authorId: null }), ConfigInvalidError);
  assert.equal(await countRevs(db), total);
});

test('хэш в строке равен configHash документа, прочитанного из jsonb', async () => {
  const rows = await db.sql<{ doc: never; hash: string }>`SELECT doc, hash FROM config_revisions`;
  assert.ok(rows.length > 3);
  for (const r of rows) assert.equal(r.hash, await configHash(r.doc), 'порядок ключей jsonb не влияет');
});

test('повторная запись того же документа — unchanged, ревизия не пишется', async () => {
  resetConfigCache();
  const cfg = await getActiveConfig({ now: BASE + 800_000 });
  const total = await countRevs(db);
  const res = await writeConfig({ docs: { global: structuredClone(cfg.global.doc) as unknown as JsonObject }, source: 'cli', authorId: null });
  assert.deepEqual(res, { written: [], unchanged: ['global'] });
  assert.equal(await countRevs(db), total);
});

test('source=preset без presetDocs — ошибка вызова', async () => {
  await assert.rejects(writeConfig({ docs: seedDocs(), source: 'preset', authorId: null }), /presetDocs/);
});

test('migrateConfigs на v1 ничего не пишет; с подменённым реестром пишет source=migration новой ревизией', async () => {
  resetConfigCache();
  const total = await countRevs(db);
  assert.deepEqual(await migrateConfigs(), { written: [], unchanged: [] });
  assert.equal(await countRevs(db), total);

  const migration: ConfigMigration = {
    from: 1,
    to: 2,
    global: (d) => ({ ...d, audit: { retentionDays: 365 } }),
    space: (d) => d,
  };
  const res = await migrateConfigs({ migrations: [migration], targetVersion: 2 });
  assert.deepEqual(res.written.map((w) => w.scope).sort(), ['global', 'sales']);
  const sid = await spaceId(db, 'sales');
  const rows = await db.sql<{ scope: string; schemaVersion: number; source: string; doc: { audit?: { retentionDays: number } } }>`
    SELECT scope, schema_version, source, doc FROM config_revisions WHERE source = 'migration' ORDER BY scope`;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.schemaVersion === 2));
  assert.equal(rows.find((r) => r.scope === 'global')?.doc.audit?.retentionDays, 365);
  assert.ok(rows.some((r) => r.scope === sid));
  // старые ревизии остались; сборка v1 по-прежнему читает свою ревизию
  const [old] = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM config_revisions WHERE schema_version = 1`;
  assert.ok((old?.n ?? 0) > 0);
  resetConfigCache();
  assert.notEqual((await getActiveConfig({ now: BASE + 900_000 })).global.doc.audit.retentionDays, 365);
  // повторный запуск: уже на целевой версии
  assert.deepEqual(await migrateConfigs({ migrations: [migration], targetVersion: 2 }), { written: [], unchanged: [] });
});

test('права: у crm_app нет UPDATE и DELETE по config_revisions, INSERT есть (grants.sql)', async () => {
  const role = 'crm_app_p5test';
  await db.exec(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} NOLOGIN; END IF; END $$`);
  try {
    const grants = readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'deploy', 'postgres', 'grants.sql'), 'utf8');
    await db.exec(`SELECT set_config('crm.app_role','${role}',false), set_config('crm.owner_role','postgres',false);\n${grants}`);
    const attempt = (stmt: 'update' | 'delete' | 'insert') =>
      db.tx(async (sql) => {
        await sql`SELECT set_config('role', ${role}, true)`;
        if (stmt === 'update') await sql`UPDATE config_revisions SET note = 'x'`;
        else if (stmt === 'delete') await sql`DELETE FROM config_revisions`;
        else await sql`INSERT INTO config_revisions (id, scope, rev, schema_version, doc, hash, source, created_at) VALUES ('x', 'global', 9999, 1, '{}', ${'0'.repeat(64)}, 'cli', 1)`;
      });
    await assert.rejects(attempt('update'), /permission denied/);
    await assert.rejects(attempt('delete'), /permission denied/);
    await attempt('insert');
  } finally {
    await db.exec(`DROP OWNED BY ${role}; DROP ROLE IF EXISTS ${role}`);
  }
});
