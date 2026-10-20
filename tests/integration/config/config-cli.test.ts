/* eslint-disable @typescript-eslint/no-explicit-any -- документы настроек в тестах читаются по путям, схема уже проверена */
// crmctl config на Postgres: apply (идемпотентность, обновление пресета, проекции, ассеты), diff, rollback, set, export.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runConfig, type ConfigCtx } from '../../../scripts/crmctl/config';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { getActiveConfig, resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import { countRevs, spaceId } from './helpers';

const REPO = path.join(import.meta.dirname, '..', '..', '..');
let db: TestDb;
let work: string;
let presets: string;
let assets: string;

before(async () => {
  db = await createTestDb();
  work = await mkdtemp(path.join(os.tmpdir(), 'crm-cli-'));
  presets = path.join(work, 'presets');
  assets = path.join(work, 'assets');
  await cp(path.join(REPO, 'presets'), presets, { recursive: true });
});
after(async () => {
  await db.close();
  await rm(work, { recursive: true, force: true });
});

function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: ConfigCtx = {
    io: { out: (l) => out.push(l), err: (l) => err.push(l) },
    openDb: async () => async () => {},
    env: { CRM_PRESETS_DIR: presets, CRM_ASSETS_DIR: assets },
    productVersion: async () => '0.1.0',
  };
  return runConfig(argv, ctx).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}

const LAYERS = ['--layers', 'base,kz,consulting-sales'];

async function editBase(fn: (doc: Record<string, any>) => void): Promise<void> {
  const file = path.join(presets, 'base', 'preset.json');
  const doc = JSON.parse(await readFile(file, 'utf8'));
  fn(doc);
  await writeFile(file, JSON.stringify(doc, null, 2));
}

async function rows<T>(q: Promise<T[]>): Promise<T[]> {
  return q;
}

test('apply без --yes: печатает дифф, ничего не пишет', async () => {
  const r = await run(['apply', ...LAYERS]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /новая область/);
  assert.match(r.out, /добавьте --yes/);
  assert.equal(await countRevs(db), 0);
  assert.deepEqual(await readdir(work).then((x) => x.includes('assets')), false);
});

test('apply --yes: ревизии source=preset с preset_doc, пространство, ассеты в томе', async () => {
  const r = await run(['apply', ...LAYERS, '--yes']);
  assert.equal(r.code, 0, r.err);
  const revs = await rows(db.sql<{ scope: string; source: string; presetDoc: unknown; note: string }>`SELECT scope, source, preset_doc, note FROM config_revisions ORDER BY scope`);
  assert.equal(revs.length, 2);
  assert.ok(revs.every((x) => x.source === 'preset' && x.presetDoc !== null));
  assert.match(revs[0]!.note, /base@2026\.10\.1, kz@2026\.10\.1, consulting-sales@2026\.10\.1/);
  assert.deepEqual((await readdir(assets)).sort(), ['logo.svg']);
  const cfg = await getActiveConfig({ now: 1 });
  assert.equal(cfg.global.doc.org.timezone, 'Asia/Almaty');
  assert.equal(cfg.spaces.sales?.doc.distribution.dailyCap, 40);
});

test('apply идемпотентен: повтор — без изменений, новых ревизий нет', async () => {
  const total = await countRevs(db);
  const r = await run(['apply', ...LAYERS, '--yes']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /без изменений: global, sales/);
  assert.equal(await countRevs(db), total);
  const d = await run(['diff', ...LAYERS]);
  assert.equal(d.code, 0, 'diff без изменений — код 0');
});

test('обновление пресета не затирает правку клиента; --force затирает', async () => {
  resetConfigCache();
  const cfg = await getActiveConfig({ now: 10 });
  // правка в интерфейсе: лимит 25
  const sp = structuredClone(cfg.spaces.sales!.doc) as any;
  sp.distribution.dailyCap = 25;
  await writeConfig({ docs: { spaces: { sales: sp } }, source: 'ui', expectedRev: { sales: cfg.spaces.sales!.rev }, authorId: null });

  // новый пресет: лимит 50 и режим auto_even
  await editBase((d) => {
    d.meta.version = '2026.10.2';
    d.spaceDefaults.distribution.dailyCap = 50;
    d.spaceDefaults.distribution.mode = 'auto_even';
  });
  const dry = await run(['diff', ...LAYERS]);
  assert.equal(dry.code, 2, 'есть что применять — код 2');
  assert.match(dry.out, /оставлено как у клиента/);
  assert.match(dry.out, /dailyCap: у клиента 25, в пресете 50/);

  const r = await run(['apply', ...LAYERS, '--yes']);
  assert.equal(r.code, 0, r.err);
  resetConfigCache();
  const after = (await getActiveConfig({ now: 20 })).spaces.sales!.doc;
  assert.equal(after.distribution.dailyCap, 25, 'правка клиента сохранена');
  assert.equal(after.distribution.mode, 'auto_even', 'нетронутый ключ обновлён');

  // --force: оба из пресета
  const f = await run(['apply', ...LAYERS, '--yes', '--force']);
  assert.equal(f.code, 0, f.err);
  assert.match(f.out, /перезаписано --force/);
  resetConfigCache();
  const forced = (await getActiveConfig({ now: 30 })).spaces.sales!.doc;
  assert.equal(forced.distribution.dailyCap, 50);
  assert.equal(forced.distribution.mode, 'auto_even');
});

test('проекции: команды и стартовая серия создаются один раз, повтор не дублирует', async () => {
  await editBase((d) => {
    d.meta.version = '2026.10.3';
    d.spaceDefaults.teams = [{ key: 'support', label: { ru: 'Поддержка' } }];
    d.spaceDefaults.booking.eventTypes = [
      { key: 'group', behavior: 'group', label: { ru: 'Группа' }, short: { ru: 'Гр' }, capacity: 20, durationMin: 90, directions: [] },
    ];
    d.spaceDefaults.booking.seedSeries = [{ key: 'weekly', eventTypeKey: 'group', weekday: 2, startTime: '11:00', durationMin: 90, location: '', format: 'online', capacity: 20 }];
  });
  const r = await run(['apply', ...LAYERS, '--yes']);
  assert.equal(r.code, 0, r.err);
  const sid = await spaceId(db, 'sales');
  const teams = () => db.sql<{ key: string }>`SELECT key FROM teams WHERE space_id = ${sid}`;
  const series = () => db.sql<{ eventTypeKey: string; weekday: number; startTime: string }>`SELECT event_type_key, weekday, start_time FROM event_series WHERE space_id = ${sid}`;
  assert.deepEqual((await teams()).map((t) => t.key), ['support']);
  assert.deepEqual(await series(), [{ eventTypeKey: 'group', weekday: 2, startTime: '11:00' }]);

  const again = await run(['apply', ...LAYERS, '--yes', '--force']);
  assert.equal(again.code, 0, again.err);
  assert.equal((await teams()).length, 1);
  assert.equal((await series()).length, 1);

  // серия, правленная вручную (РОП), и новая стартовая серия в пресете: если серии есть — не создаём
  await db.sql`UPDATE event_series SET start_time = '12:30' WHERE space_id = ${sid}`;
  await editBase((d) => {
    d.meta.version = '2026.10.4';
    d.spaceDefaults.booking.seedSeries = [{ key: 'weekly', eventTypeKey: 'group', weekday: 5, startTime: '09:00', durationMin: 90, location: '', format: 'online', capacity: 20 }];
  });
  await run(['apply', ...LAYERS, '--yes', '--force']);
  assert.deepEqual(await series(), [{ eventTypeKey: 'group', weekday: 2, startTime: '12:30' }]);
});

test('rollback: новая ревизия с содержимым старой, старые на месте', async () => {
  const sid = await spaceId(db, 'sales');
  const before = await rows(db.sql<{ rev: number; doc: any }>`SELECT rev, doc FROM config_revisions WHERE scope = ${sid} ORDER BY rev`);
  assert.ok(before.length >= 4);
  const first = before[0]!;
  const dry = await run(['rollback', 'sales', String(first.rev)]);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /добавьте --yes/);
  assert.equal((await countRevs(db, sid)), before.length);

  const r = await run(['rollback', 'sales', String(first.rev), '--yes']);
  assert.equal(r.code, 0, r.err);
  const after = await rows(db.sql<{ rev: number; source: string; note: string; doc: any }>`SELECT rev, source, note, doc FROM config_revisions WHERE scope = ${sid} ORDER BY rev`);
  assert.equal(after.length, before.length + 1);
  const last = after.at(-1)!;
  assert.equal(last.source, 'rollback');
  assert.equal(last.note, `rollback to rev ${first.rev}`);
  assert.deepEqual(last.doc, first.doc);
  assert.deepEqual(after.slice(0, before.length).map((x) => x.rev), before.map((x) => x.rev));

  // повтор: уже совпадает
  const same = await run(['rollback', 'sales', String(first.rev), '--yes']);
  assert.match(same.out, /нечего откатывать/);
  const missing = await run(['rollback', 'sales', '999', '--yes']);
  assert.equal(missing.code, 1);
});

test('rollback отказывает для ревизии более новой схемы', async () => {
  const [{ n }] = await db.sql<{ n: number }>`SELECT max(rev)::int AS n FROM config_revisions WHERE scope = 'global'` as [{ n: number }];
  await db.sql`INSERT INTO config_revisions (id, scope, rev, schema_version, doc, hash, source, note, created_at)
    VALUES ('future-1', 'global', ${n + 1}, 99, '{}', ${'a'.repeat(64)}, 'cli', '', 1)`;
  const r = await run(['rollback', 'global', String(n + 1), '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.err, /откат невозможен/);
});

test('diff <область> <revA> <revB>', async () => {
  const sid = await spaceId(db, 'sales');
  const [a, b] = (await db.sql<{ rev: number }>`SELECT rev FROM config_revisions WHERE scope = ${sid} ORDER BY rev LIMIT 2`).map((x) => x.rev);
  const r = await run(['diff', 'sales', String(a), String(b)]);
  assert.ok(r.code === 0 || r.code === 2, r.err);
  assert.equal((await run(['diff', 'sales', '1', '9999'])).code, 1);
  assert.equal((await run(['diff', 'nowhere', '1', '2'])).code, 1);
});

test('set: точечная правка с проверкой, source=cli; неверное значение — код 3', async () => {
  const bad = await run(['set', 'sales', 'distribution.dailyCap', '9999', '--yes']);
  assert.equal(bad.code, 3);
  assert.match(bad.err, /dailyCap/);

  const dry = await run(['set', 'sales', 'distribution.dailyCap', '33']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /добавьте --yes/);

  const r = await run(['set', 'sales', 'distribution.dailyCap', '33', '--yes']);
  assert.equal(r.code, 0, r.err);
  resetConfigCache();
  assert.equal((await getActiveConfig({ now: 100 })).spaces.sales!.doc.distribution.dailyCap, 33);
  const [last] = await db.sql<{ source: string }>`SELECT source FROM config_revisions ORDER BY created_at DESC, rev DESC LIMIT 1`;
  assert.equal(last?.source, 'cli');

  // элемент массива по ключу
  const k = await run(['set', 'sales', 'pipelines[key=sales].stages[key=lost].staleDays', '30', '--yes']);
  assert.equal(k.code, 0, k.err);
});

test('export печатает набор: global и документы пространств по ключу', async () => {
  const r = await run(['export']);
  assert.equal(r.code, 0, r.err);
  const out = JSON.parse(r.out);
  assert.deepEqual(Object.keys(out).sort(), ['global', 'spaces']);
  assert.deepEqual(Object.keys(out.spaces), ['sales']);
  assert.equal(out.global.org.timezone, 'Asia/Almaty');
});

test('apply: набор не прошёл проверку — код 3 и ничего не пишется', async () => {
  const total = await countRevs(db);
  await editBase((d) => {
    d.meta.version = '2026.10.5';
    d.spaceDefaults.distribution.participantRoles = ['ghost'];
  });
  const r = await run(['apply', ...LAYERS, '--yes']);
  assert.equal(r.code, 3);
  assert.match(r.err, /нет роли «ghost»/);
  assert.equal(await countRevs(db), total);
});

test('apply: логотип темы без ассета — код 1, ничего не пишется', async () => {
  const total = await countRevs(db);
  await editBase((d) => {
    d.meta.version = '2026.10.6';
    d.spaceDefaults.distribution.participantRoles = ['manager'];
    d.global.theme.logo = 'missing.svg';
  });
  const r = await run(['apply', ...LAYERS, '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.err, /theme\.logo «missing\.svg»/);
  assert.equal(await countRevs(db), total);
});

test('apply: плохой ассет накладки (расширение) — код 1 до записи', async () => {
  const total = await countRevs(db);
  await editBase((d) => {
    d.global.theme.logo = 'logo.svg';
  });
  const overlay = path.join(work, 'overlay');
  await mkdir(path.join(overlay, 'assets'), { recursive: true });
  await writeFile(path.join(overlay, 'preset.json'), JSON.stringify({ meta: { key: 'ovl', version: '1.0.0', schemaVersion: 1, extends: ['base'] } }));
  await writeFile(path.join(overlay, 'assets', 'evil.js'), 'alert(1)');
  const r = await run(['apply', '--layers', `base,${overlay}`, '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.err, /расширение/);
  assert.equal(await countRevs(db), total);
});
