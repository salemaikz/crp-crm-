// Выгрузки отчётов и журнал (R3b §2.3–2.4, D-263): CSV и XLSX, заголовки ответа, Sec-Fetch-Site, флаг XLSX, журнал до
// отдачи тела с белым списком meta без значений, директор и «только чтение» лицензии, журнал по ролям. Только синтетика.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as exportRoute from '../../../src/app/api/reports/[key]/export/route';
import * as journalRoute from '../../../src/app/api/export/journal/route';
import * as reportRoute from '../../../src/app/api/reports/[key]/route';
import * as directorRoute from '../../../src/app/api/reports/director/route';
import { getExportJournal } from '../../../src/server/domain/reports';
import { limitsFor, readSpreadsheet } from '../../../src/server/platform/files';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { enterSeedWorld } from '../../isolation/harness/actors';
import { closeClientsWorld, openClientsWorld } from '../clients/world';
import { SEED_NOW, SPACE, U, actAs, enterReportsConfig, leaveReportsConfig, seedCall, viewerOf } from './helpers';

let db: TestDb;
const clock = { now: SEED_NOW };
/** Местное время Алматы (UTC+5) → epoch-мс. */
const at = (day: number, h: number, m = 0) => Date.UTC(2026, 9, day, h - 5, m);
const RANGE = 'from=2026-10-12&to=2026-10-14';

before(async () => {
  db = await openClientsWorld();
  enterReportsConfig(clock);
  // два итога оператора A в периоде: строка в отчёте «Операторы»
  await seedCall(db.sql, { id: 'x1', cardId: 'cd-a-30', clientId: 'cl-a-30', userId: U.opA, at: at(12, 10), kind: 'no_answer' });
  await seedCall(db.sql, { id: 'x2', cardId: 'cd-a-30', clientId: 'cl-a-30', userId: U.opA, at: at(12, 11), kind: 'callback' });
});
after(async () => {
  leaveReportsConfig();
  await closeClientsWorld(db);
});

/** Флаг XLSX на время вызова (вне development/test флаги выключены по умолчанию). */
async function withFlag<R>(value: '0' | '1', fn: () => Promise<R>): Promise<R> {
  const prev = process.env.FEATURE_REPORTS_EXPORT;
  process.env.FEATURE_REPORTS_EXPORT = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.FEATURE_REPORTS_EXPORT;
    else process.env.FEATURE_REPORTS_EXPORT = prev;
  }
}

async function get(as: string | null, key: string, qs: string, headers: Record<string, string> = {}): Promise<Response> {
  actAs(as);
  return exportRoute.GET(new Request(`http://crm.test/api/reports/${key}/export?${qs}`, { headers }), { params: Promise.resolve({ key }) });
}

type AuditRow = { action: string; actorId: string; spaceId: string; entity: string; meta: Record<string, unknown> };
const journal = async (): Promise<AuditRow[]> =>
  db.sql<AuditRow>`SELECT action, actor_id, space_id, entity, meta FROM audit_log WHERE action LIKE 'export.%' ORDER BY created_at, id`;

test('CSV: файл для Excel, заголовки ответа, строка журнала до отдачи — только имена фильтров', async () => {
  const before = (await journal()).length;
  const res = await get(U.rop, 'operators', `format=csv&${RANGE}&group=day&users=${U.opA}`, { 'sec-fetch-site': 'same-origin' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="crm-operators-2026-10-12_2026-10-14.csv"');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
  const text = new TextDecoder().decode(bytes);
  const [head, row] = text.split('\r\n');
  assert.ok(head?.startsWith('Оператор;Период;Выдано;Итогов'), head);
  assert.ok(row?.startsWith('Оператор Синтетик А;2026-10-12;'), row);
  const rows = await journal();
  assert.equal(rows.length, before + 1);
  const last = rows[0]!; // первая выгрузка файла
  assert.equal(last.action, 'export.report');
  assert.equal(last.entity, 'export');
  assert.equal(last.actorId, U.rop);
  assert.equal(last.spaceId, SPACE);
  assert.deepEqual(Object.keys(last.meta).sort(), ['filterKeys', 'format', 'kind', 'periodDays', 'reportKey', 'rows']);
  assert.deepEqual(last.meta, { kind: 'report', reportKey: 'operators', format: 'csv', rows: 3, filterKeys: ['group', 'users'], periodDays: 3 });
  // значения фильтров (id сотрудников) и цифры номеров в журнал не попадают
  assert.ok(!JSON.stringify(last.meta).includes(U.opA));
  assert.ok(!/\d{5,}/.test(JSON.stringify(last.meta)));
});

test('XLSX: книга читается, первая строка — заголовки; выключенный флаг — 404 без записи в журнал', async () => {
  const res = await withFlag('1', () => get(U.rop, 'operators', `format=xlsx&${RANGE}`));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(res.headers.get('content-disposition') ?? '', /filename="crm-operators-2026-10-12_2026-10-14\.xlsx"/);
  const book = await readSpreadsheet(new Uint8Array(await res.arrayBuffer()), { limits: limitsFor({ maxFileMb: 5, maxRows: 1000 }) });
  assert.deepEqual(book.sheets, ['Операторы']);
  assert.equal(book.grid[0]?.[0], 'Оператор');
  assert.ok(book.grid.some((r) => r[0] === 'Оператор Синтетик А'));
  assert.equal((await journal()).filter((r) => r.meta.format === 'xlsx').length, 1);

  const before = (await journal()).length;
  await withFlag('0', async () => {
    assert.equal((await get(U.rop, 'operators', `format=xlsx&${RANGE}`)).status, 404);
    // CSV флагом не режется
    assert.equal((await get(U.rop, 'operators', `format=csv&${RANGE}`)).status, 200);
  });
  assert.equal((await journal()).length, before + 1);
});

test('чужой сайт ссылкой выгрузку не запускает (403), журнал не засоряется; адресная строка (none) — можно', async () => {
  const before = (await journal()).length;
  assert.equal((await get(U.rop, 'revenue', `format=csv&${RANGE}`, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await get(U.rop, 'revenue', `format=csv&${RANGE}`, { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await journal()).length, before);
  assert.equal((await get(U.rop, 'revenue', `format=csv&${RANGE}`, { 'sec-fetch-site': 'none' })).status, 200);
});

test('права: оператор 403, гость 401, директор выгружает; неизвестный отчёт 404; лишний параметр и формат 400', async () => {
  assert.equal((await get(U.opA, 'operators', `format=csv&${RANGE}`)).status, 403);
  assert.equal((await get(null, 'operators', `format=csv&${RANGE}`)).status, 401);
  assert.equal((await get(U.director, 'funnel', `format=csv&${RANGE}&by=source`)).status, 200);
  assert.equal((await get(U.rop, 'nope', `format=csv&${RANGE}`)).status, 404);
  assert.equal((await get(U.rop, 'revenue', `format=csv&${RANGE}&group=day`)).status, 400);
  assert.equal((await get(U.rop, 'revenue', `format=pdf&${RANGE}`)).status, 400);
  const wide = await get(U.rop, 'revenue', 'format=csv&from=2026-01-01&to=2026-10-14');
  assert.deepEqual(await wide.json(), { error: 'bad_request', detail: 'period_invalid' });
  // каждая выгрузка отчёта во всех вариантах — это файл: все пять отчётов
  for (const key of ['operators', 'funnel', 'revenue', 'attendance', 'reasons']) assert.equal((await get(U.rop, key, `format=csv&${RANGE}`)).status, 200, key);
});

test('лицензия «только чтение»: выгрузка работает и пишется в журнал (D-054)', async () => {
  enterSeedWorld({ license: 'read_only' });
  try {
    const before = (await journal()).length;
    assert.equal((await get(U.director, 'operators', `format=csv&${RANGE}`)).status, 200);
    assert.equal((await journal()).length, before + 1);
  } finally {
    enterSeedWorld();
  }
});

test('журнал: администратор видит всё, директор — своё пространство, РОП и оператор — 403', async () => {
  // строка другого пространства (видна только администратору)
  await db.sql`INSERT INTO spaces (id, key, is_default, created_at) VALUES ('sp-other', 'other', FALSE, ${SEED_NOW})`;
  await db.sql`INSERT INTO audit_log (id, actor_id, space_id, action, entity, entity_id, meta, created_at)
               VALUES ('au-other', ${U.rop}, 'sp-other', 'export.report', 'export', ${U.rop}, '{"kind":"report","format":"csv","rows":1,"filterKeys":[],"periodDays":1,"reportKey":"revenue"}', ${SEED_NOW + 1})`;
  const admin = await getExportJournal(await viewerOf(U.admin), { before: null, limit: 50 });
  const dir = await getExportJournal(await viewerOf(U.director), { before: null, limit: 50 });
  assert.ok(admin.rows.some((r) => r.id === 'au-other'));
  assert.ok(!dir.rows.some((r) => r.id === 'au-other'));
  assert.equal(dir.rows.length, admin.rows.length - 1);
  assert.ok(dir.rows.length >= 6);
  const first = dir.rows.find((r) => r.actorUserId === U.rop && r.reportKey === 'operators')!;
  assert.equal(first.actorName, 'РОП Синтетик');
  assert.equal(first.kind, 'report');
  await assert.rejects(getExportJournal(await viewerOf(U.rop), { before: null, limit: 50 }), { code: 'forbidden' });
  await assert.rejects(getExportJournal(await viewerOf(U.opA), { before: null, limit: 50 }), { code: 'forbidden' });

  // маршрут: страницы по курсору без повторов; РОП 403, гость 401
  const call = async (as: string | null, qs = '') => {
    actAs(as);
    return journalRoute.GET(new Request(`http://crm.test/api/export/journal${qs}`), { params: Promise.resolve({}) });
  };
  const p1 = (await (await call(U.admin)).json()) as { rows: { id: string; at: number }[]; next: { at: number; id: string } | null };
  assert.equal(p1.next, null);
  const mid = p1.rows[2]!;
  const p2 = (await (await call(U.admin, `?before=${mid.at}:${mid.id}`)).json()) as { rows: { id: string }[] };
  assert.deepEqual(p2.rows.map((r) => r.id), p1.rows.slice(3).map((r) => r.id));
  assert.equal((await call(U.rop)).status, 403);
  assert.equal((await call(null)).status, 401);
  assert.equal((await call(U.admin, '?before=bad')).status, 400);
});

test('FEATURE_REPORTS=0 (бой до приёмки, D-295): отчёт, его CSV и панель директора — 404 без записи в журнал; журнал выгрузок работает', async () => {
  const prev = process.env.FEATURE_REPORTS;
  process.env.FEATURE_REPORTS = '0';
  try {
    const before = (await journal()).length;
    actAs(U.rop);
    const report = await reportRoute.GET(new Request(`http://crm.test/api/reports/operators?${RANGE}`), { params: Promise.resolve({ key: 'operators' }) });
    assert.equal(report.status, 404);
    assert.equal((await get(U.rop, 'operators', `format=csv&${RANGE}`, { 'sec-fetch-site': 'same-origin' })).status, 404);
    assert.equal((await get(U.director, 'revenue', `format=csv&${RANGE}`)).status, 404);
    actAs(U.director);
    assert.equal((await directorRoute.GET(new Request('http://crm.test/api/reports/director'), { params: Promise.resolve({}) })).status, 404);
    assert.equal((await journal()).length, before, 'журнал не пишется');
    // журнал выгрузок — контроль полной выгрузки, он за флагом не стоит
    actAs(U.director);
    assert.equal((await journalRoute.GET(new Request('http://crm.test/api/export/journal'), { params: Promise.resolve({}) })).status, 200);
  } finally {
    if (prev === undefined) delete process.env.FEATURE_REPORTS;
    else process.env.FEATURE_REPORTS = prev;
  }
  actAs(U.rop);
  const on = await reportRoute.GET(new Request(`http://crm.test/api/reports/operators?${RANGE}`), { params: Promise.resolve({ key: 'operators' }) });
  assert.equal(on.status, 200, 'флаг снова включён — отчёт работает');
});
