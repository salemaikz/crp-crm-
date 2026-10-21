// Настройки продаж (R2b, D-267): сервис и маршруты на Postgres 16. Синтетика прогона изоляции, пресет ЦРП.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { resetAccessForTests } from '../../../src/server/access/testing';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { loadDistributionConfig } from '../../../src/server/domain/distribution';
import { seedIsolation, U } from '../../isolation/harness/seed';
import { applySeedConfig } from '../../isolation/harness/config';
import { actAs, enterSeedWorld } from '../../isolation/harness/actors';
import { GET as salesGet, PATCH as salesPatch } from '../../../src/app/api/admin/settings/sales/route';
import { GET as holidaysGet, PUT as holidaysPut } from '../../../src/app/api/admin/settings/holidays/route';

const ORIGIN = 'http://localhost:3000';
let db: TestDb;
let spaceId = '';

before(async () => {
  // экран настроек — за FEATURE_SALES_SETTINGS (D-295); тесты идут как стенд: флаг включён, выключенный — отдельный тест
  process.env.FEATURE_SALES_SETTINGS = '1';
  db = await createTestDb();
  await seedIsolation(db.sql);
});
after(async () => {
  resetAccessForTests();
  await db.close();
});
beforeEach(async () => {
  // у каждого теста свой набор ревизий: чистим и ставим пресет заново
  await db.sql`DELETE FROM config_revisions`;
  resetConfigCache();
  await applySeedConfig();
  const [s] = await db.sql<{ id: string }>`SELECT id FROM spaces WHERE is_default LIMIT 1`;
  spaceId = s!.id;
  enterSeedWorld();
  actAs(U.rop);
});

const ctx = { params: Promise.resolve({}) };
const req = (method: string, url: string, body?: unknown): Request =>
  new Request(`${ORIGIN}${url}`, {
    method,
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const SALES = '/api/admin/settings/sales';
const HOL = '/api/admin/settings/holidays';
type View = { revs: { global: number; space: number }; values: { dailyCap: number | null; schedule: { from: string; to: string; everyMin: number } | null; callWindow: { start: string; end: string }; callsPerHourTarget: number | null }; holidays: { date: string; kind: string; note: string }[]; can: { sales: boolean; holidays: boolean } };
const read = async (): Promise<View> => (await (await salesGet(req('GET', SALES), ctx)).json()) as View;
const patch = (body: unknown) => salesPatch(req('PATCH', SALES, body), ctx);
const revRows = (scope: string) => db.sql<{ rev: number; source: string; note: string; authorId: string | null }>`SELECT rev, source, note, author_id FROM config_revisions WHERE scope = ${scope} ORDER BY rev`;

test('GET: значения из активных настроек и права по роли', async () => {
  const v = await read();
  assert.equal(v.can.sales, true);
  assert.equal(v.can.holidays, false);
  assert.equal(typeof v.values.dailyCap, 'number');
  assert.match(v.values.callWindow.start, /^\d\d:\d\d$/);
  assert.ok(v.revs.global >= 1 && v.revs.space >= 1);
  assert.ok(Array.isArray(v.holidays));
});

test('PATCH: ревизия source=ui с note и автором; следующее чтение раздачи видит новый лимит', async () => {
  const before = await read();
  const res = await patch({ expectedRev: before.revs, patch: { dailyCap: 37, schedule: { everyMin: 60 } } });
  assert.equal(res.status, 200);
  const after = (await res.json()) as View;
  assert.equal(after.values.dailyCap, 37);
  assert.equal(after.values.schedule?.everyMin, 60);
  assert.equal(after.revs.space, before.revs.space + 1);
  assert.equal(after.revs.global, before.revs.global, 'global не менялся — новой ревизии нет');
  const last = (await revRows(spaceId)).at(-1)!;
  assert.equal(last.source, 'ui');
  assert.equal(last.note, 'ui: distribution.dailyCap, distribution.schedule.everyMin');
  assert.equal(last.authorId, U.rop);
  const dist = await loadDistributionConfig(spaceId, Date.now());
  assert.equal(dist.settings.dailyCap, 37);
  const [audit] = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'config.write' AND entity_id = ${spaceId}`;
  assert.equal(audit!.n, 1);
});

test('PATCH окна звонков пишет global, а не пространство; оба пути — обе области', async () => {
  const b = await read();
  const r1 = (await (await patch({ expectedRev: b.revs, patch: { callWindow: { end: '19:00' } } })).json()) as View;
  assert.equal(r1.values.callWindow.end, '19:00');
  assert.equal(r1.revs.global, b.revs.global + 1);
  assert.equal(r1.revs.space, b.revs.space);
  const r2 = (await (await patch({ expectedRev: r1.revs, patch: { callWindow: { start: '08:30' }, callsPerHourTarget: null } })).json()) as View;
  assert.equal(r2.revs.global, r1.revs.global + 1);
  assert.equal(r2.revs.space, r1.revs.space + 1);
  assert.equal(r2.values.callsPerHourTarget, null);
});

test('PATCH теми же значениями ревизию не создаёт', async () => {
  const b = await read();
  const r = (await (await patch({ expectedRev: b.revs, patch: { dailyCap: b.values.dailyCap } })).json()) as View;
  assert.deepEqual(r.revs, b.revs);
});

test('409 config_conflict при старой ревизии; ничего не записано', async () => {
  const b = await read();
  assert.equal((await patch({ expectedRev: b.revs, patch: { dailyCap: 11 } })).status, 200);
  const before = (await revRows(spaceId)).length;
  const stale = await patch({ expectedRev: b.revs, patch: { dailyCap: 12 } });
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), { error: 'conflict', detail: 'config_conflict' });
  assert.equal((await revRows(spaceId)).length, before);
  // старая ревизия global конфликтует, только если global пишется (окно звонков)
  const cur = await read();
  const staleGlobal = await patch({ expectedRev: { global: cur.revs.global - 1, space: cur.revs.space }, patch: { callWindow: { start: '09:00', end: '18:00' } } });
  assert.equal(staleGlobal.status, 409);
});

test('правка праздников администратором не даёт 409 РОП, меняющему только dailyCap', async () => {
  const b = await read(); // экран РОП открыт с этими ревизиями
  actAs(U.admin);
  const hol = await holidaysPut(req('PUT', HOL, { expectedRev: { global: b.revs.global }, holidays: [{ date: '2027-03-08', kind: 'holiday', note: 'Синтетика' }] }), ctx);
  assert.equal(hol.status, 200);
  actAs(U.rop);
  const res = await patch({ expectedRev: b.revs, patch: { dailyCap: 14 } });
  assert.equal(res.status, 200);
  assert.equal((await read()).values.dailyCap, 14);
});

test('гонка: два PATCH с одной ревизией — один 200, другой 409', async () => {
  const b = await read();
  const [x, y] = await Promise.all([patch({ expectedRev: b.revs, patch: { dailyCap: 21 } }), patch({ expectedRev: b.revs, patch: { dailyCap: 22 } })]);
  assert.deepEqual([x.status, y.status].sort(), [200, 409]);
});

test('400 invalid с путями, без значений', async () => {
  const b = await read();
  const bad = await patch({ expectedRev: b.revs, patch: { schedule: { from: '20:00', to: '10:00' } } });
  assert.equal(bad.status, 400);
  const body = (await bad.json()) as { error: string; detail: string; issues: { path: string }[] };
  assert.equal(body.detail, 'invalid');
  assert.deepEqual(body.issues, [{ path: 'schedule.to' }]);
  const outOfRange = await patch({ expectedRev: b.revs, patch: { dailyCap: 9999 } });
  assert.equal(outOfRange.status, 400);
  const text = JSON.stringify(await outOfRange.json());
  assert.ok(!text.includes('9999'), 'значение в ответе');
  assert.match(text, /patch\.dailyCap/);
  const foreign = await patch({ expectedRev: b.revs, patch: { capOverride: true } });
  assert.equal(foreign.status, 400);
  assert.equal((await patch({ expectedRev: b.revs, patch: {} })).status, 400);
  assert.equal((await salesPatch(new Request(`${ORIGIN}${SALES}`, { method: 'PATCH', headers: { Origin: ORIGIN }, body: '{' }), ctx)).status, 400);
  assert.equal((await revRows(spaceId)).length, b.revs.space);
});

test('права: оператор и директор не читают и не пишут; РОП не правит праздники', async () => {
  const b = await read();
  for (const who of [U.opA, U.director]) {
    actAs(who);
    // директор — роль «только чтение»: мутации блокируются раньше проверки права (423)
    const denied = [403, 423];
    assert.equal((await salesGet(req('GET', SALES), ctx)).status, 403, `GET ${who}`);
    assert.ok(denied.includes((await patch({ expectedRev: b.revs, patch: { dailyCap: 1 } })).status), `PATCH ${who}`);
    assert.ok(denied.includes((await holidaysPut(req('PUT', HOL, { expectedRev: { global: b.revs.global }, holidays: [] }), ctx)).status), `PUT ${who}`);
  }
  actAs(U.rop);
  assert.equal((await holidaysPut(req('PUT', HOL, { expectedRev: { global: b.revs.global }, holidays: [] }), ctx)).status, 403);
  assert.equal((await read()).values.dailyCap, b.values.dailyCap);
  // без сессии — 401
  actAs(null);
  assert.equal((await salesGet(req('GET', SALES), ctx)).status, 401);
});

test('администратор: читает, правит праздники (по возрастанию даты), продажи без роли не правит', async () => {
  actAs(U.admin);
  const b = await read();
  assert.equal(b.can.holidays, true);
  assert.equal(b.can.sales, false, 'нет права settings.sales');
  assert.equal((await patch({ expectedRev: b.revs, patch: { dailyCap: 5 } })).status, 403);
  const holidays = [
    { date: '2027-03-08', kind: 'holiday', note: 'Синтетика 2' },
    { date: '2026-12-31', kind: 'workday', note: 'Перенос' },
  ];
  const res = await holidaysPut(req('PUT', HOL, { expectedRev: { global: b.revs.global }, holidays }), ctx);
  assert.equal(res.status, 200);
  const after = (await res.json()) as View;
  assert.deepEqual(after.holidays.map((h) => h.date), ['2026-12-31', '2027-03-08']);
  const last = (await revRows('global')).at(-1)!;
  assert.equal(last.source, 'ui');
  assert.equal(last.note, 'ui: calendar.holidays');
  assert.equal(last.authorId, U.admin);
  const g = (await (await holidaysGet(req('GET', HOL), ctx)).json()) as { holidays: unknown[]; can: { holidays: boolean } };
  assert.equal(g.holidays.length, 2);
  // старая ревизия global — 409
  const stale = await holidaysPut(req('PUT', HOL, { expectedRev: { global: b.revs.global }, holidays: [] }), ctx);
  assert.equal(stale.status, 409);
  // дубль даты и мусор — 400
  const dup = await holidaysPut(req('PUT', HOL, { expectedRev: { global: after.revs.global }, holidays: [holidays[0], holidays[0]] }), ctx);
  assert.equal(dup.status, 400);
  const badDate = await holidaysPut(req('PUT', HOL, { expectedRev: { global: after.revs.global }, holidays: [{ date: '2026-02-30', kind: 'holiday', note: '' }] }), ctx);
  assert.equal(badDate.status, 400);
});

test('Origin обязателен для мутаций', async () => {
  const b = await read();
  const r = await salesPatch(new Request(`${ORIGIN}${SALES}`, { method: 'PATCH', headers: { Origin: 'http://evil.example' }, body: JSON.stringify({ expectedRev: b.revs, patch: { dailyCap: 3 } }) }), ctx);
  assert.equal(r.status, 403);
});


test('FEATURE_SALES_SETTINGS=0 (бой до приёмки, D-295): чтение, правка и праздники — 404, настройки не меняются', async () => {
  const prev = process.env.FEATURE_SALES_SETTINGS;
  process.env.FEATURE_SALES_SETTINGS = '0';
  try {
    const before = (await revRows('global')).length;
    assert.equal((await salesGet(req('GET', SALES), ctx)).status, 404);
    assert.equal((await patch({ expectedRev: { global: 1, space: 1 }, patch: { dailyCap: 41 } })).status, 404);
    actAs(U.admin);
    assert.equal((await holidaysGet(req('GET', HOL), ctx)).status, 404);
    const put = await holidaysPut(req('PUT', HOL, { expectedRev: { global: 1 }, holidays: [] }), ctx);
    assert.equal(put.status, 404);
    assert.equal((await revRows('global')).length, before);
  } finally {
    if (prev === undefined) delete process.env.FEATURE_SALES_SETTINGS;
    else process.env.FEATURE_SALES_SETTINGS = prev;
  }
  actAs(U.rop);
  assert.equal((await salesGet(req('GET', SALES), ctx)).status, 200, 'флаг снова включён — экран работает');
});
