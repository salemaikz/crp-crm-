// Стенд на Vercel (D-318) на маршрутах: загрузка импорта — 409, номера вне блока +7 709 — 400 stand_phone,
// приём лидов закрыт. Вне режима те же запросы проходят как раньше. Postgres 16, синтетика прогона изоляции.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { resetAccessForTests } from '../../../src/server/access/testing';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { seedIsolation, U, clientOf } from '../../isolation/harness/seed';
import { applySeedConfig } from '../../isolation/harness/config';
import { actAs, enterSeedWorld } from '../../isolation/harness/actors';
import { POST as uploadPost } from '../../../src/app/api/import/uploads/route';
import { POST as phonesPost } from '../../../src/app/api/clients/[id]/phones/route';
import { POST as proposePost } from '../../../src/app/api/clients/proposals/route';
import { POST as invitePost } from '../../../src/app/api/team/staff/route';
import { isClosedFromOutside as ingestClosed } from '../../../src/server/domain/intake/gate';

const ORIGIN = 'http://localhost:3000';
// Режим стенда в процессе теста: признак сборки и переменные Vercel; адрес задан явно (на localhost нет https)
const STAND_ENV: Record<string, string> = { VERCEL: '1', CRM_STAND: '1', CRM_VERCEL_STAND_BUILD: '1', APP_ORIGIN: ORIGIN, FEATURE_IMPORT: '1' };
let db: TestDb;
let saved: Record<string, string | undefined> = {};

/** Включить или выключить режим; адрес и флаг импорта остаются в обоих случаях. */
const setStand = (on: boolean): void => {
  for (const [k, v] of Object.entries(STAND_ENV)) {
    if (on || k === 'APP_ORIGIN' || k === 'FEATURE_IMPORT') process.env[k] = v;
    else delete process.env[k];
  }
};

before(async () => {
  saved = Object.fromEntries(Object.keys(STAND_ENV).map((k) => [k, process.env[k]]));
  db = await createTestDb();
  await seedIsolation(db.sql);
  resetConfigCache();
  await applySeedConfig();
});
after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetAccessForTests();
  await db.close();
});
beforeEach(() => {
  setStand(true);
  enterSeedWorld();
});
afterEach(() => setStand(false));

const ctx = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });
const post = (url: string, body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }): Request =>
  new Request(`${ORIGIN}${url}`, { method: 'POST', headers: { Origin: ORIGIN, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const json = async (r: Response): Promise<{ error?: string; detail?: string }> => (await r.json()) as { error?: string; detail?: string };

test('загрузка файла импорта на стенде — 409 stand_unavailable, вне режима до этого не доходит', async () => {
  actAs(U.rop);
  const url = '/api/import/uploads?profile=operator_tables&snapshotDay=2026-10-20';
  const r = await uploadPost(post(url, 'Наименование;Телефон\r\nТОО Синтетик;+7 709 111 22 33\r\n', { 'Content-Type': 'text/csv', 'X-File-Name': 'stand.csv' }), ctx());
  assert.equal(r.status, 409);
  assert.equal((await json(r)).error, 'stand_unavailable');
  setStand(false);
  const off = await uploadPost(post(url, 'Наименование;Телефон\r\nТОО Синтетик;+7 709 111 22 33\r\n', { 'Content-Type': 'text/csv', 'X-File-Name': 'stand.csv' }), ctx());
  assert.notEqual((await json(off)).error, 'stand_unavailable');
});

test('номер клиенту: вне блока +7 709 — 400 stand_phone, синтетический проходит; вне режима — любой', async () => {
  actAs(U.opA);
  const id = clientOf('a', 1);
  const bad = await phonesPost(post(`/api/clients/${id}/phones`, { opId: crypto.randomUUID(), phone: '+7 701 555 01 23' }), ctx({ id }));
  assert.equal(bad.status, 400);
  assert.equal((await json(bad)).detail, 'stand_phone');
  const ok = await phonesPost(post(`/api/clients/${id}/phones`, { opId: crypto.randomUUID(), phone: '+7 709 555 77 01' }), ctx({ id }));
  assert.ok(ok.status < 300, `ждали успех, получили ${ok.status}`);
  setStand(false);
  const off = await phonesPost(post(`/api/clients/${id}/phones`, { opId: crypto.randomUUID(), phone: '+7 701 555 01 24' }), ctx({ id }));
  assert.ok(off.status < 300, `вне режима ждали успех, получили ${off.status}`);
});

test('«Предложить контакт» на стенде: номер вне блока +7 709 — 400 stand_phone', async () => {
  actAs(U.opA);
  const r = await proposePost(post('/api/clients/proposals', { opId: crypto.randomUUID(), phone: '+7 701 555 02 23', name: 'ТОО Синтетик Плюс' }), ctx());
  assert.equal(r.status, 400);
  assert.equal((await json(r)).detail, 'stand_phone');
});

test('приглашение сотрудника на стенде: номер вне блока +7 709 — 400 stand_phone', async () => {
  actAs(U.admin);
  const r = await invitePost(post('/api/team/staff', { phone: '+7 701 555 03 23', name: 'Синтетик Новый', roleKey: 'operator' }), ctx());
  assert.equal(r.status, 400);
  assert.equal((await json(r)).detail, 'stand_phone');
});

test('приём лидов на стенде закрыт при любом INGEST_PUBLIC', () => {
  const h = { get: () => null };
  assert.equal(ingestClosed(h, { ...process.env, INGEST_PUBLIC: '1' }), true);
  setStand(false);
  assert.equal(ingestClosed(h, { ...process.env, INGEST_PUBLIC: '1' }), false);
});
