// Прогон изоляции для временного владельца (docs/tasks-team-design.md §8, D-252, D-303): оператор A замещает
// оператора B на карточке B1. Пока замещение действует — A открывает клиента и задачу B по ней; после окончания
// срока (задача `absence` ещё не успела снять временного) и после снятия — тот же 404, что у несуществующего id,
// без данных клиента B в ответе. Маршруты вызываются как в бою, через обёртки route().
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Хуки — до загрузки src/** (как в run.test.ts): всё, что тянет src, грузится динамически
register('./runner/hooks.mjs', import.meta.url);
const { scanApp } = await import('../helpers/appScan');
const { matchEntries } = await import('../helpers/manifestCoverage');
const { createTestDb } = await import('../../src/server/platform/db/testing');
const { resetAccessForTests } = await import('../../src/server/access/testing');
const { actAs, enterSeedWorld } = await import('./harness/actors');
const { applySeedConfig } = await import('./harness/config');
const { allEntries } = await import('./harness/load');
const { SEED_TODAY, U, seedIsolation } = await import('./harness/seed');
const { leakViolations, notFoundViolations } = await import('./runner/checks');
const { invoke } = await import('./runner/invoke');
const { FOREIGN, markFixtures, needlesOf } = await import('./runner/objects');
const { MISSING_ID } = await import('./runner/runner');
const { cancelAbsence, createAbsence } = await import('../../src/server/domain/distribution/absence');
const { viewerOf } = await import('./harness/actors');
const { overrideDistributionDepsForTests } = await import('../../src/server/domain/distribution/deps');
const { loadDistributionConfig } = await import('../../src/server/domain/distribution/settings');
const { SEED_NOW } = await import('./harness/seed');

type Db = Awaited<ReturnType<typeof createTestDb>>;
type Unit = ReturnType<typeof scanApp>[number];
type Entry = Awaited<ReturnType<typeof allEntries>>[number];

let db: Db;
const probes: { entity: 'client' | 'task'; unit: Unit; entry: Entry }[] = [];
const CARD = FOREIGN.card.id;

before(async () => {
  db = await createTestDb();
  await seedIsolation(db.sql);
  await applySeedConfig();
  await markFixtures(db.sql);
  enterSeedWorld();
  const entries = await allEntries();
  const matched = matchEntries(scanApp(), entries);
  for (const [path, entity] of [['/api/clients/[id]', 'client'], ['/api/tasks/[id]', 'task']] as const) {
    const hit = [...matched].find(([, e]) => e.kind === 'route' && e.method === 'GET' && e.path === path);
    assert.ok(hit, `в манифесте нет GET ${path}`);
    probes.push({ entity, unit: hit[0], entry: hit[1] });
  }
});
after(async () => {
  actAs(null);
  resetAccessForTests();
  await db?.close();
});

const setActing = (userId: string | null, untilDay: string) =>
  db.sql`UPDATE cards SET acting_user_id = ${userId}, acting_until_day = ${untilDay} WHERE id = ${CARD}`;

/** A → объект B: пусто — 404 как у несуществующего и без утечек. */
async function closedForA(label: string): Promise<string[]> {
  const v: string[] = [];
  for (const p of probes) {
    const foreign = FOREIGN[p.entity].id;
    const a = await invoke(p.unit, p.entry, { userId: U.opA, id: foreign });
    const missing = await invoke(p.unit, p.entry, { userId: U.opA, id: MISSING_ID });
    v.push(...notFoundViolations({ foreign: a, missing, foreignId: foreign, missingId: MISSING_ID }).map((m) => `${label} ${p.entity}: ${m}`));
    v.push(...leakViolations(`${label} ${p.entity}`, a, await needlesOf(db.sql, p.entity)));
  }
  return v;
}

test('временный владелец: пока замещает — видит клиента и задачу владельца; срок вышел — 404; снят — 404', async () => {
  try {
    // Контроль: без замещения A чужое не видит
    assert.deepEqual(await closedForA('до замещения'), []);

    // Замещение действует по сегодняшний день включительно
    await setActing(U.opA, SEED_TODAY);
    for (const p of probes) {
      const r = await invoke(p.unit, p.entry, { userId: U.opA, id: FOREIGN[p.entity].id });
      assert.equal(r.status, 200, `замещение действует: ${p.entity} открывается`);
    }

    // Последний день замещения — вчера: задача `absence` временного ещё не сняла, видимости уже нет
    const yesterday = new Date(Date.parse(`${SEED_TODAY}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    await setActing(U.opA, yesterday);
    assert.deepEqual(await closedForA('срок замещения вышел'), []);

    // Временный снят (отмена отсутствия или задача `absence`)
    await setActing(null, '');
    assert.deepEqual(await closedForA('после снятия'), []);
  } finally {
    await setActing(null, '');
    actAs(null);
  }
});

test('отмена настоящего отсутствия: временный владелец A видит клиента и задачу B, после cancelAbsence — 404', async () => {
  const rop = await viewerOf(U.rop);
  const opId = globalThis.crypto.randomUUID();
  overrideDistributionDepsForTests({ config: loadDistributionConfig, now: () => SEED_NOW });
  try {
    await db.sql`DELETE FROM absences`;
    // Карточка в повторе с ближайшим звонком — такие ядро передаёт заместителю
    await db.sql`UPDATE cards SET next_call_at = ${SEED_NOW + 3_600_000} WHERE id = ${CARD}`;
    // РОП ставит отсутствие B на сегодня и завтра, A — заместитель: ядро само назначает временного
    const abs = await createAbsence(rop, { opId, userId: U.opB, fromDay: SEED_TODAY, toDay: '2026-10-30', substituteUserId: U.opA });
    assert.ok(abs.applied.acting > 0, 'временные назначены');
    actAs(null);
    for (const p of probes) {
      const r = await invoke(p.unit, p.entry, { userId: U.opA, id: FOREIGN[p.entity].id });
      assert.equal(r.status, 200, `во время отсутствия: ${p.entity} открывается`);
    }
    await cancelAbsence(rop, abs.id);
    actAs(null);
    assert.deepEqual(await closedForA('после отмены отсутствия'), []);
    const left = await db.sql`SELECT 1 FROM cards WHERE id = ${CARD} AND acting_user_id IS NOT NULL`;
    assert.equal(left.length, 0, 'временный снят у карточки');
  } finally {
    overrideDistributionDepsForTests(null);
    await db.sql`DELETE FROM absences`;
    await db.sql`UPDATE cards SET next_call_at = NULL WHERE id = ${CARD}`;
    await setActing(null, '');
    actAs(null);
  }
});
