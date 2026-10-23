/* eslint-disable @typescript-eslint/no-explicit-any -- строки БД читаются по путям */
// W2 (pipeline-v2 §5.4): импорт пишет cards мимо persist, поэтому кэш признаков и heat пересчитывается в самой
// транзакции применения — без ручного backfill. Синтетика, номера +7 709 ….
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { imports } from '@crm/core';
import { importService } from '../../../src/server/domain/import';
import { refreshCardDerived } from '../../../src/server/domain/cards';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { newId } from '../../../src/server/platform/db';
import { SYSTEM_COLUMNS, T0, makeWorld, upload, type World } from './helpers';

const HEAT = { states: { new: 20, retry: 5, callback: 100 }, reasons: {}, flags: { attendedGroup: 30, attendedIndividual: 40, noShow: 10, purchased: 60, lprYes: 50 } };
let db: TestDb;
let w: World;
before(async () => {
  db = await createTestDb();
  w = await makeWorld(db, 30, 5, [{ label: 'Оператор-01 (Синий)', name: 'Оператор-01', color: 'Синий', ranges: [[3, 50]] }], HEAT);
});
after(async () => {
  await db.close();
});

const HEAD = Object.keys(SYSTEM_COLUMNS);
const mk = (o: Record<string, string>) => HEAD.map((h) => o[h] ?? '');
const P = (n: number) => `+7 709 777 00 ${String(10 + n)}`;
const csv = (rows: string[][]) => Buffer.from(imports.toCsv([['Журнал'], HEAD, ...rows], ';'), 'utf-8');

async function run(rows: string[][], now: number) {
  const up = await upload(w.lead, csv(rows));
  const s = await importService.preview(w.lead, up.importId, { ownerMap: w.ownerMap }, now);
  assert.equal(s.blockers.length, 0, JSON.stringify(s.blockers));
  return importService.apply(w.lead, up.importId, { fingerprint: s.fingerprint, ownerMap: w.ownerMap }, now + 10);
}

const cardOf = async (name: string) =>
  (await db.sql<any>`SELECT c.id, c.state, c.heat, c.lpr, c.client_id, c.attended_group_at FROM cards c JOIN clients cl ON cl.id = c.client_id WHERE cl.name = ${name}`)[0];

test('создание со state и lpr: heat посчитан сразу, повторный пересчёт ничего не меняет', async () => {
  const r = await run(
    [
      mk({ Тип: 'ТОО', Наименование: 'ТОО «Горячий Синтетик»', Телефон: P(1), Ответ: 'Перезвонить', 'ЛПР подтвержден': 'да' }),
      mk({ Тип: 'ТОО', Наименование: 'ТОО «Холодный Синтетик»', Телефон: P(2), Ответ: 'Отключен/Не берет' }),
    ],
    T0,
  );
  assert.equal(r.written.cardsCreated, 2);
  const hot = await cardOf('ТОО «Горячий Синтетик»');
  const cold = await cardOf('ТОО «Холодный Синтетик»');
  assert.equal(hot.state, 'callback');
  assert.equal(hot.lpr, 'yes');
  assert.ok(hot.heat > 0, `heat перезвона с ЛПР > 0, получено ${hot.heat}`);
  assert.ok(hot.heat > cold.heat, 'порядок «Перезвона»: горячая выше холодной');
  const again = await db.tx((tx) => refreshCardDerived({ kind: 'system', job: 'test', now: T0 } as any, tx, [hot.id, cold.id]));
  assert.equal(again, 0, 'кэш уже верен: пересчёт ничего не пишет');
});

test('обновление состояния из таблицы: признак явки клиента и heat пересчитаны в той же транзакции', async () => {
  const row = (outcome: string) => [mk({ Тип: 'ТОО', Наименование: 'ТОО «Обновляемый Синтетик»', Телефон: P(3), Ответ: outcome, 'ЛПР подтвержден': 'да' })];
  await run(row(''), T0 + 1000);
  const before = await cardOf('ТОО «Обновляемый Синтетик»');
  const attended = T0 - 3 * 86_400_000;
  await db.sql`INSERT INTO bookings (id, space_id, kind, event_type_key, client_id, card_id, booking_date, start_time, starts_at, duration_min, status, booked_by_user_id, created_at, updated_at)
               VALUES (${newId()}, ${w.spaceId}, 'individual', 'consult', ${before.clientId}, ${before.id}, '2026-10-18', '11:00', ${attended}, 60, 'attended', ${w.lead.userId}, ${T0}, ${T0})`;
  const r = await run(row('Перезвонить'), T0 + 2000);
  assert.equal(r.written.cardsUpdated, 1);
  const after = await cardOf('ТОО «Обновляемый Синтетик»');
  assert.equal(after.state, 'callback');
  const [c] = await db.sql<any>`SELECT attended_individual_at FROM cards WHERE id = ${after.id}`;
  assert.equal(c.attendedIndividualAt, attended, 'признак явки взят из записей клиента');
  assert.ok(after.heat > 0);
  const again = await db.tx((tx) => refreshCardDerived({ kind: 'system', job: 'test', now: T0 } as any, tx, [after.id]));
  assert.equal(again, 0);
});
