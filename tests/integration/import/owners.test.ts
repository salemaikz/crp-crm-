/* eslint-disable @typescript-eslint/no-explicit-any -- строки БД читаются по путям */
// Владельцы строк и отложенные итоги (D-222): профиль «диапазон строк → оператор» без слотов не применяется;
// строка, чей рабочий итог отложен из-за отсутствия владельца, при повторе после настройки слотов получает
// владельца и итог; задержанная строка так и остаётся на разборе; третий повтор — 0 изменений.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { imports } from '@crm/core';
import { importService, ImportError, type ImportActor } from '../../../src/server/domain/import';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { FIELD_TARGETS, SYSTEM_COLUMNS, T0, installImportConfig, mkMember, mkUser, snapshot, spaceIdOf, upload } from './helpers';

let db: TestDb;
let lead: ImportActor;
let op1: string;
let op2: string;

const S1 = 'Оператор-01 (Синий)';
const S2 = 'Оператор-02 (Красный)';
const HEAD = Object.keys(SYSTEM_COLUMNS);
const mk = (o: Record<string, string>) => HEAD.map((h) => o[h] ?? '');
const P = (n: number) => `+7 709 777 00 ${String(10 + n)}`;

/** Строки файла: № 3 — с владельцем, № 4 — «Перезвонить» вне диапазонов, № 5 — ИП на разбор юриста, № 6 — без итога. */
const body = () =>
  Buffer.from(
    imports.toCsv(
      [
        ['Журнал'],
        HEAD,
        mk({ Тип: 'ТОО', Наименование: 'ТОО «Своя Строка»', Телефон: P(1), Ответ: 'Отключен/Не берет' }),
        mk({ Тип: 'ТОО', Наименование: 'ТОО «Без Владельца»', Телефон: P(2), Ответ: 'Перезвонить' }),
        mk({ Тип: 'ИП', Наименование: 'ИП Задержанный Синтетик', Телефон: P(3), Ответ: 'Перезвонить' }),
        mk({ Тип: 'ТОО', Наименование: 'ТОО «Пустой Ответ»', Телефон: P(4) }),
      ],
      ';',
    ),
    'utf-8',
  );

const cardOf = async (name: string) => (await db.sql<any>`SELECT c.*, cl.id AS cid FROM cards c JOIN clients cl ON cl.id = c.client_id WHERE cl.name = ${name}`)[0];

before(async () => {
  db = await createTestDb();
  process.env.FEATURE_IMPORT = '1';
  await installImportConfig({ fieldTargets: { ...FIELD_TARGETS } });
  const spaceId = await spaceIdOf(db);
  const leadId = await mkUser(db, 0, 'Руководитель Синтетик');
  await mkMember(db, leadId, spaceId, 'lead');
  lead = { userId: leadId, spaceId };
  op1 = await mkUser(db, 1, 'Оператор 1');
  await mkMember(db, op1, spaceId, 'manager');
  op2 = await mkUser(db, 2, 'Оператор 2');
  await mkMember(db, op2, spaceId, 'manager');
});
after(async () => {
  await db.close();
});

test('профиль «диапазон строк» без слотов: блокер no_owner_slots, «Применить» ничего не пишет', async () => {
  const up = await upload(lead, body());
  const s = await importService.preview(lead, up.importId, { ownerMap: {} }, T0);
  assert.ok(s.blockers.includes('no_owner_slots'), JSON.stringify(s.blockers));
  const before = await snapshot(db);
  await assert.rejects(
    importService.apply(lead, up.importId, { fingerprint: s.fingerprint, ownerMap: {} }, T0 + 1),
    (e: unknown) => e instanceof ImportError && e.code === 'blocked' && (e.detail.blockers ?? []).includes('no_owner_slots'),
  );
  assert.deepEqual(await snapshot(db), before);
});

test('отложенный без владельца итог применяется при повторе после настройки слотов; задержанная строка ждёт', async () => {
  // Слоты заданы, но строка № 4 вне диапазонов: без владельца, «Перезвонить» отложен (D-115)
  await installImportConfig({ slots: [{ label: S1, ranges: [[3, 3]] }], fieldTargets: { ...FIELD_TARGETS } });
  const first = await upload(lead, body(), { now: T0 + 10 });
  const s1 = await importService.preview(lead, first.importId, { ownerMap: { [S1]: op1 } }, T0 + 10);
  assert.deepEqual(s1.blockers, []);
  assert.equal(s1.heldWithWorkingOutcome, 2, '№ 4 без владельца и ИП на разборе');
  await importService.apply(lead, first.importId, { fingerprint: s1.fingerprint, ownerMap: { [S1]: op1 } }, T0 + 11);
  const lost = await cardOf('ТОО «Без Владельца»');
  assert.deepEqual([lost.state, lost.ownerUserId, lost.callsTotal], ['new', null, 0]);

  // Сопровождение дописало слот на строки 4–10; новый оператор ещё не сопоставлен — блокер, а не тихий пропуск
  await installImportConfig({ slots: [{ label: S1, ranges: [[3, 3]] }, { label: S2, ranges: [[4, 10]] }], fieldTargets: { ...FIELD_TARGETS } });
  const second = await upload(lead, body(), { now: T0 + 20 });
  const unmapped = await importService.preview(lead, second.importId, { ownerMap: { [S1]: op1 } }, T0 + 20);
  assert.ok(unmapped.blockers.includes('unmapped_slots'));
  assert.ok(unmapped.unmappedSlots.includes(S2));

  const map = { [S1]: op1, [S2]: op2 };
  const s2 = await importService.preview(lead, second.importId, { ownerMap: map }, T0 + 20);
  assert.deepEqual(s2.blockers, []);
  assert.equal(s2.counts.byAction.update_state, 1, 'только строка с отложенным итогом');
  assert.equal(s2.counts.byAction.skip_same, 3, 'своя, задержанная и пустая — повтор');
  assert.deepEqual(s2.perOperator.map((o) => [o.userId, o.count]), [[op2, 1]]);
  const r = await importService.apply(lead, second.importId, { fingerprint: s2.fingerprint, ownerMap: map }, T0 + 21);
  assert.equal(r.written.cardsUpdated, 1);
  assert.deepEqual(r.written.assigned, { [op2]: 1 });

  const resumed = await cardOf('ТОО «Без Владельца»');
  assert.deepEqual([resumed.state, resumed.ownerUserId, resumed.assignedAt, resumed.callsTotal], ['callback', op2, T0 + 21, 1]);
  const [call] = await db.sql<any>`SELECT via, outcome_kind FROM calls WHERE client_id = ${resumed.cid}`;
  assert.deepEqual([call.via, call.outcomeKind], ['import', 'callback']);
  const task = await db.sql<any>`SELECT assignee_user_id FROM tasks WHERE client_id = ${resumed.cid} AND source = 'callback' AND status = 'open'`;
  assert.deepEqual(task.map((t: any) => t.assigneeUserId), [op2]);
  const log = await db.sql<any>`SELECT to_user_id, kind, run_id FROM assign_log WHERE card_id = ${resumed.id}`;
  assert.deepEqual(log.map((l: any) => [l.toUserId, l.kind, l.runId]), [[op2, 'import', second.importId]]);

  // ИП на разборе юриста: итог по-прежнему отложен, владельца нет
  const held = await cardOf('ИП Задержанный Синтетик');
  assert.deepEqual([held.state, held.ownerUserId, held.holdReason, held.callsTotal], ['new', null, 'rule', 0]);
  // пустой ответ в пуле: итога не было — повтор его не трогает
  const pool = await cardOf('ТОО «Пустой Ответ»');
  assert.deepEqual([pool.ownerUserId, pool.version], [null, 0]);

  // Третья загрузка того же файла: всё — повтор, ни одной записи
  const third = await upload(lead, body(), { now: T0 + 30 });
  const s3 = await importService.preview(lead, third.importId, { ownerMap: map }, T0 + 30);
  assert.equal(s3.counts.byAction.skip_same, 4);
  const before = await snapshot(db);
  await importService.apply(lead, third.importId, { fingerprint: s3.fingerprint, ownerMap: map }, T0 + 31);
  assert.deepEqual(await snapshot(db), before);
});
