/* eslint-disable @typescript-eslint/no-explicit-any -- строки БД читаются по путям */
// Побочные эффекты применения (дизайн C4d §7.2–7.3): «Полный отказ» → HMAC в стоп-листе, общий номер →
// задача РОП; «Недоступен»; «Подтвержден» без записи; задержанная строка с рабочим итогом; событие import.row.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { imports } from '@crm/core';
import { importService } from '../../../src/server/domain/import';
import { overrideImportContextForTests } from '../../../src/server/domain/import/settings';
import { phoneHmac } from '../../../src/server/platform/hmac';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { SYSTEM_COLUMNS, T0, makeWorld, upload, type World } from './helpers';

let db: TestDb;
let w: World;
before(async () => {
  db = await createTestDb();
  w = await makeWorld(db, 30, 5, [{ label: 'Оператор-01 (Синий)', name: 'Оператор-01', color: 'Синий', ranges: [[3, 50]] }]);
});
after(async () => {
  overrideImportContextForTests(null);
  await db.close();
});

const HEAD = Object.keys(SYSTEM_COLUMNS);
const mk = (o: Record<string, string>) => HEAD.map((h) => o[h] ?? '');
const P = (n: number) => `+7 709 888 00 ${String(10 + n)}`;

test('Полный отказ, общий номер, «Недоступен», «Подтвержден», задержанная строка с итогом', async () => {
  const rows = [
    mk({ Тип: 'ТОО', Наименование: 'ТОО «Отказ Один»', Телефон: P(1), Ответ: 'Полный отказ' }),
    mk({ Тип: 'ТОО', Наименование: 'ТОО «Отказ Общий»', Телефон: P(2), Ответ: 'Полный отказ' }),
    mk({ Тип: 'ТОО', Наименование: 'ТОО «Сосед По Номеру»', Телефон: P(2) }),
    mk({ Тип: 'ТОО', Наименование: 'ТОО «Недоступный»', Телефон: P(4), Ответ: 'Недоступен' }),
    mk({ Тип: 'ТОО', Наименование: 'ТОО «Подтверждённый»', Телефон: P(5), Ответ: 'Подтвержден' }),
    mk({ Тип: 'ИП', Наименование: 'ИП Задержанный Синтетик', Телефон: P(6), Ответ: 'Перезвонить' }),
    mk({ Тип: 'ТОО', Наименование: 'ТОО «Не Берёт»', Телефон: P(7), Ответ: 'Отключен/Не берет' }),
  ];
  const body = Buffer.from(imports.toCsv([['Журнал'], HEAD, ...rows], ';'), 'utf-8');
  const up = await upload(w.lead, body);
  assert.equal(up.rows, 7);
  const s = await importService.preview(w.lead, up.importId, { ownerMap: w.ownerMap }, T0);
  assert.equal(s.blockers.length, 0, JSON.stringify(s.blockers));
  assert.equal(s.heldWithWorkingOutcome, 1, 'ИП с «Перезвонить»');
  const r = await importService.apply(w.lead, up.importId, { fingerprint: s.fingerprint, ownerMap: w.ownerMap }, T0 + 10);
  assert.equal(r.written.clientsCreated, 7);

  const cardOf = async (name: string) => (await db.sql<any>`SELECT c.*, cl.id AS cid FROM cards c JOIN clients cl ON cl.id = c.client_id WHERE cl.name = ${name}`)[0];

  // «Полный отказ» без общего номера: карточка закрыта, HMAC номера в стоп-листе
  const one = await cardOf('ТОО «Отказ Один»');
  assert.equal(one.state, 'do_not_call');
  const hits = await db.sql<any>`SELECT source FROM stop_list WHERE phone_hmac = ${phoneHmac('77098880' + '011')}`;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].source, 'import');

  // общий номер: в стоп-лист не идёт, РОП получает задачу подтвердить
  const shared = await cardOf('ТОО «Отказ Общий»');
  assert.equal(shared.state, 'do_not_call');
  assert.equal((await db.sql<any>`SELECT 1 FROM stop_list WHERE phone_hmac = ${phoneHmac('77098880' + '012')}`).length, 0);
  const confirm = await db.sql<any>`SELECT assignee_user_id, status FROM tasks WHERE client_id = ${shared.cid} AND source = 'stoplist_confirm'`;
  assert.equal(confirm.length, 1);
  assert.equal(confirm[0].assigneeUserId, null);
  assert.equal(confirm[0].status, 'open');

  // «Недоступен» при одном номере: номер нерабочий, карточка списана
  const bad = await cardOf('ТОО «Недоступный»');
  assert.equal(bad.state, 'written_off');
  assert.equal(bad.closeReasonCode, 'no_working_phone');
  const [ph] = await db.sql<any>`SELECT is_working, is_primary FROM client_phones WHERE client_id = ${bad.cid}`;
  assert.deepEqual([ph.isWorking, ph.isPrimary], [false, false]);

  // «Подтвержден» без записи: «Перезвон: сейчас» + задача «Уточнить договорённость» владельцу
  const agreed = await cardOf('ТОО «Подтверждённый»');
  assert.equal(agreed.state, 'callback');
  assert.equal(agreed.nextCallAt, T0 + 10);
  const clar = await db.sql<any>`SELECT assignee_user_id FROM tasks WHERE client_id = ${agreed.cid} AND source = 'clarify_import'`;
  assert.equal(clar.length, 1);
  assert.equal(clar[0].assigneeUserId, agreed.ownerUserId);
  const [call] = await db.sql<any>`SELECT via, user_id, outcome_kind, occurred_at FROM calls WHERE client_id = ${agreed.cid}`;
  assert.deepEqual([call.via, call.userId, call.outcomeKind], ['import', null, 'agreed']);
  assert.equal(call.occurredAt, Date.UTC(2026, 9, 20, 18, 0, 0), 'день снимка 18:00');

  // ИП задержан: «новая» без владельца, звонка нет, итог — в событии ленты
  const ip = await cardOf('ИП Задержанный Синтетик');
  assert.deepEqual([ip.state, ip.ownerUserId, ip.holdReason, ip.holdCode, ip.callsTotal], ['new', null, 'rule', 'legal_review', 0]);
  assert.equal((await db.sql<any>`SELECT 1 FROM calls WHERE client_id = ${ip.cid}`).length, 0);
  const [ev] = await db.sql<any>`SELECT data, actor_id, ref_type, ref_id FROM client_events WHERE client_id = ${ip.cid} AND kind = 'import.row'`;
  assert.equal(ev.data.outcomeKey, 'callback');
  assert.equal(ev.data.answerRaw, 'Перезвонить');
  assert.equal(ev.data.deferred, true);
  assert.equal(ev.actorId, w.lead.userId);
  assert.equal(ev.refType, 'import');
  assert.equal(ev.refId, up.importId);

  // «Не берёт»: повтор через настройки, один недозвон
  const retry = await cardOf('ТОО «Не Берёт»');
  assert.deepEqual([retry.state, retry.attempts, retry.noAnswerTotal], ['retry', 1, 1]);

  // выдачи импортом и автор — РОП; у звонка нет автора (D-067)
  const assigns = await db.sql<any>`SELECT actor_id, kind, counts_to_cap FROM assign_log`;
  assert.ok(assigns.length >= 5);
  assert.ok(assigns.every((a: any) => a.actorId === w.lead.userId && a.kind === 'import' && a.countsToCap === false));
});
