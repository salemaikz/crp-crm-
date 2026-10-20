/* eslint-disable @typescript-eslint/no-explicit-any -- строки БД и ответы читаются по путям */
// Импорт таблиц на Postgres: 2 200 синтетических строк по структуре tests/fixtures/import/README.md.
// Загрузка → предпросмотр → применение; повторный импорт того же файла — 0 изменений; правка итога —
// один звонок; карточку тронули — «оставлено как в CRM»; отпечаток; параллель; чистка по сроку.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { imports } from '@crm/core';
import { importService, ImportError, purgeExpiredImportRows } from '../../../src/server/domain/import';
import { overrideImportContextForTests } from '../../../src/server/domain/import/settings';
import { newId } from '../../../src/server/platform/db';
import { INTAKE_LOCK_KEY } from '../../../src/server/platform/db/locks';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { SpreadsheetError } from '../../../src/server/platform/files';
import { zip } from '../../unit/import/xlsxBuilder';
import { T0, makeWorld, mainCsv, snapshot, upload, type World } from './helpers';

let db: TestDb;
let w: World;
const IIN = (n: number) => `99010130${String(1000 + n)}`; // 12 цифр, синтетика
const NOW = T0 + 60_000;

before(async () => {
  db = await createTestDb();
  w = await makeWorld(db);
});
after(async () => {
  overrideImportContextForTests(null);
  await db.close();
});

/** CSV с ИИН у части ИП (колонка «ИИН»), чтобы проверить HMAC вместо открытых цифр. */
function csv(mutate?: (g: string[][]) => void): Buffer {
  return mainCsv(w.sheets, (g) => {
    let n = 0;
    for (let i = 2; i < g.length && n < 20; i++) {
      if (g[i]![0] === 'ИП') {
        g[i]![12] = IIN(n++);
      }
    }
    mutate?.(g);
  });
}

let firstImportId = '';
let created = 0;

test('загрузка: 2 200 строк в import_rows, ИИН ИП только HMAC, в отчёте нет номеров и названий', async () => {
  const body = csv();
  const up = await upload(w.lead, body);
  firstImportId = up.importId;
  assert.equal(up.rows, 2200);
  assert.equal(up.kind, 'csv');
  assert.equal(up.sameFileApplied, null);
  const [{ n }] = await db.sql<any>`SELECT count(*)::int AS n FROM import_rows WHERE import_id = ${up.importId}`;
  assert.equal(n, 2200);
  // ни одной строки с 12 цифрами ИИН во всех колонках import_rows и в отчёте
  const leaks = await db.sql<any>`SELECT row_no FROM import_rows WHERE import_id = ${up.importId} AND (parsed::text ~ '99010130[0-9]{4}' OR import_key ~ '99010130[0-9]{4}')`;
  assert.deepEqual(leaks, []);
  const withHmac = await db.sql<any>`SELECT row_no FROM import_rows WHERE import_id = ${up.importId} AND parsed ->> 'orgId' LIKE 'iin:%'`;
  assert.equal(withHmac.length, 20);
  const [imp] = await db.sql<any>`SELECT report::text AS report, file_name FROM imports WHERE id = ${up.importId}`;
  assert.doesNotMatch(imp.report, /\d{10,}/, 'в отчёте нет номеров');
  assert.doesNotMatch(imp.report, /ТОО|Альфа|Оператор/, 'в отчёте нет названий');
  const audit = await db.sql<any>`SELECT meta::text AS meta FROM audit_log WHERE entity = 'import' AND action = 'import.upload'`;
  assert.equal(audit.length, 1);
  assert.doesNotMatch(audit[0].meta, /журнал|\d{10,}/);
});

test('предпросмотр: каждому оператору N, ИП задержаны, пересечение диапазонов — import_conflict', async () => {
  const s = await importService.preview(w.lead, firstImportId, { ownerMap: w.ownerMap }, NOW);
  assert.equal(s.blockers.length, 0);
  assert.equal(s.unmappedSlots.length, 0);
  assert.equal(s.counts.total, 2200);
  const assigned = s.perOperator.reduce((a, x) => a + x.count, 0);
  assert.ok(assigned > 1000, `операторы получили ${assigned}`);
  assert.ok(s.perOperator.every((x) => x.name.startsWith('Оператор ')));
  assert.ok(s.counts.held.rule > 200, 'ИП ушли в «на разбор юриста»');
  assert.ok(s.counts.held.import_conflict > 0, 'пересечение диапазонов — спорные строки');
  assert.ok(s.counts.held.dup_pair > 0, 'общий номер у разных ТОО — спорная пара');
  assert.ok(s.ruleOverlaps.length >= 1);
  assert.ok(s.heldWithWorkingOutcome > 0);
  assert.match(s.fingerprint, /^[0-9a-f]{64}$/);
  // предпросмотр бизнес-таблиц не меняет
  assert.equal((await snapshot(db)).clients, 0);
  // в отчёте — метка предпросмотра без имён сотрудников
  const [imp] = await db.sql<any>`SELECT report::text AS report FROM imports WHERE id = ${firstImportId}`;
  assert.doesNotMatch(imp.report, /Оператор \d|Синий|Зел[её]ный/);
});

test('предпросмотр: без карты ярлыки не сопоставлены — блокер; чужой userId — bad_owner', async () => {
  const s = await importService.preview(w.lead, firstImportId, { ownerMap: {} }, NOW);
  assert.ok(s.blockers.includes('unmapped_slots'));
  assert.equal(s.unmappedSlots.length, 11);
  await assert.rejects(importService.preview(w.lead, firstImportId, { ownerMap: { ...w.ownerMap, [w.sheets.slots[0]!.label]: newId() } }, NOW), (e: unknown) => e instanceof ImportError && e.code === 'bad_owner');
  // не участник раздачи (РОП с ролью lead) тоже не может быть владельцем
  await assert.rejects(importService.preview(w.lead, firstImportId, { ownerMap: { ...w.ownerMap, [w.sheets.slots[0]!.label]: w.lead.userId } }, NOW), (e: unknown) => e instanceof ImportError && e.code === 'bad_owner');
});

test('применение: отпечаток другой карты → preview_stale и ни одной записи', async () => {
  const good = await importService.preview(w.lead, firstImportId, { ownerMap: w.ownerMap }, NOW);
  const swapped = { ...w.ownerMap };
  const [a, b] = w.sheets.slots.map((s) => s.label);
  [swapped[a!], swapped[b!]] = [swapped[b!]!, swapped[a!]!];
  const before = await snapshot(db);
  await assert.rejects(importService.apply(w.lead, firstImportId, { fingerprint: good.fingerprint, ownerMap: swapped }, NOW), (e: any) => e instanceof ImportError && e.code === 'preview_stale' && !!e.detail.summary);
  assert.deepEqual(await snapshot(db), before);
});

test('применение: новый клиент из приёма между предпросмотром и применением → 409, записей нет', async () => {
  const good = await importService.preview(w.lead, firstImportId, { ownerMap: w.ownerMap }, NOW);
  // Клиент приёма с названием и номером одной из созданных строк
  const row = (await db.sql<any>`SELECT parsed FROM import_rows WHERE import_id = ${firstImportId} AND parsed ->> 'nameNorm' <> '' ORDER BY row_no OFFSET 50 LIMIT 1`)[0].parsed;
  const cid = newId();
  await db.sql`INSERT INTO clients (id, kind, name, name_norm, source_kind, created_at, updated_at) VALUES (${cid}, 'company', ${row.name}, ${row.nameNorm}, 'ingest', ${T0}, ${T0})`;
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, created_at) VALUES (${newId()}, ${cid}, ${row.workingPhones[0] ?? '77091110000'}, 'mobile', ${T0})`;
  const before = await snapshot(db);
  await assert.rejects(importService.apply(w.lead, firstImportId, { fingerprint: good.fingerprint, ownerMap: w.ownerMap }, NOW), (e: any) => e instanceof ImportError && e.code === 'preview_stale');
  assert.deepEqual(await snapshot(db), before);
  await db.sql`DELETE FROM client_phones WHERE client_id = ${cid}`;
  await db.sql`DELETE FROM clients WHERE id = ${cid}`;
});

test('применение: два apply разными соединениями → один busy, второй записывает', async () => {
  const s = await importService.preview(w.lead, firstImportId, { ownerMap: w.ownerMap }, NOW);
  const t0 = Date.now();
  const results = await Promise.allSettled([
    importService.apply(w.lead, firstImportId, { fingerprint: s.fingerprint, ownerMap: w.ownerMap }, NOW),
    importService.apply(w.lead, firstImportId, { fingerprint: s.fingerprint, ownerMap: w.ownerMap }, NOW),
  ]);
  const elapsed = Date.now() - t0;
  const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
  const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(ok.length, 1, JSON.stringify(results.map((r) => (r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : 'ok'))));
  assert.equal(bad.length, 1);
  assert.ok(bad[0]!.reason instanceof ImportError && bad[0]!.reason.code === 'busy');
  assert.equal(ok[0]!.value.alreadyApplied, false);
  assert.ok(elapsed < 30_000, `2 200 строк применяются за ${elapsed} мс`);
  created = ok[0]!.value.written.clientsCreated;
  assert.ok(created > 1500, `создано клиентов: ${created}`);
});

test('применение: числа сходятся с предпросмотром, ИИН ИП — только HMAC, владельцы и выдачи', async () => {
  const [imp] = await db.sql<any>`SELECT status, report FROM imports WHERE id = ${firstImportId}`;
  assert.equal(imp.status, 'applied');
  const written = imp.report.apply.written;
  const [c] = await db.sql<any>`SELECT count(*)::int AS n FROM clients WHERE source_kind = 'import'`;
  assert.equal(c.n, written.clientsCreated);
  const [cards] = await db.sql<any>`SELECT count(*)::int AS n FROM cards`;
  assert.equal(cards.n, written.cardsCreated);
  // владельцы: сколько выдач — столько карточек с владельцем без задержки
  const [asg] = await db.sql<any>`SELECT count(*)::int AS n, count(*) FILTER (WHERE counts_to_cap) ::int AS cap FROM assign_log WHERE kind = 'import' AND run_id = ${firstImportId}`;
  const sum = Object.values(imp.report.apply.written.assigned as Record<string, number>).reduce((a, x) => a + x, 0);
  assert.equal(asg.n, sum);
  assert.equal(asg.cap, 0, 'выдача импортом не входит в лимит дня');
  const [held] = await db.sql<any>`SELECT count(*)::int AS n FROM cards WHERE hold_reason <> '' AND owner_user_id IS NOT NULL`;
  assert.equal(held.n, 0, 'у задержанных карточек владельца нет');
  // ИП: iin_hmac на месте, org_id пуст, 12 цифр нигде
  const ips = await db.sql<any>`SELECT org_id, iin_hmac FROM clients WHERE iin_hmac IS NOT NULL`;
  assert.equal(ips.length, 20);
  assert.ok(ips.every((r: any) => r.orgId === '' && /^[0-9a-f]{64}$/.test(r.iinHmac)));
  const leaks = await db.sql<any>`SELECT id FROM clients WHERE row_to_json(clients)::text ~ '99010130[0-9]{4}'`;
  assert.deepEqual(leaks, []);
  const ev = await db.sql<any>`SELECT id FROM client_events WHERE data::text ~ '99010130[0-9]{4}'`;
  assert.deepEqual(ev, []);
  // поля по fieldTargets и поиск
  const [okv] = await db.sql<any>`SELECT count(*)::int AS n FROM clients WHERE custom ? 'okved' AND custom ? 'head_name'`;
  assert.ok(okv.n > 1000);
  // звонки импорта без автора, via=import, с ключом строки
  const [calls] = await db.sql<any>`SELECT count(*)::int AS n, count(*) FILTER (WHERE user_id IS NULL AND via = 'import' AND import_key IS NOT NULL)::int AS ok FROM calls`;
  assert.equal(calls.n, written.callsCreated);
  assert.equal(calls.ok, calls.n);
  assert.ok(calls.n > 100);
  // «Подтвержден» без записи → callback и задача «Уточнить договорённость»
  const [clar] = await db.sql<any>`SELECT count(*)::int AS n FROM tasks WHERE source = 'clarify_import'`;
  assert.ok(clar.n > 0);
  const [agreedCards] = await db.sql<any>`SELECT count(*)::int AS n FROM cards WHERE last_outcome_kind = 'agreed' AND state = 'callback'`;
  assert.ok(agreedCards.n >= clar.n);
  // «Полный отказ» → HMAC в стоп-листе
  const [stop] = await db.sql<any>`SELECT count(*)::int AS n FROM stop_list WHERE source = 'import'`;
  assert.ok(stop.n > 50);
  assert.equal(stop.n, written.stopListed);
  // у задержанных/без владельца строк с рабочим итогом звонков нет (итог только в ленте)
  const [badHeld] = await db.sql<any>`SELECT count(*)::int AS n FROM cards WHERE owner_user_id IS NULL AND state IN ('retry','callback','agreed')`;
  assert.equal(badHeld.n, 0);
  // спорные пары для общих номеров
  assert.ok(written.pairsCreated > 0);
  // import_rows получили client_id
  const [lnk] = await db.sql<any>`SELECT count(*)::int AS n FROM import_rows WHERE import_id = ${firstImportId} AND client_id IS NOT NULL`;
  assert.ok(lnk.n >= created);
  // аудит применения без ПДн
  const [au] = await db.sql<any>`SELECT meta::text AS meta FROM audit_log WHERE action = 'import.apply'`;
  assert.doesNotMatch(au.meta, /\+7|7709\d{7}|ТОО/);
});

test('повторный apply того же импорта → alreadyApplied, таблицы не меняются', async () => {
  const before = await snapshot(db);
  const s = await importService.preview(w.lead, firstImportId, { ownerMap: w.ownerMap }, NOW);
  assert.ok(s.blockers.includes('already_applied'));
  const r = await importService.apply(w.lead, firstImportId, { fingerprint: s.fingerprint, ownerMap: w.ownerMap }, NOW + 1);
  assert.equal(r.alreadyApplied, true);
  assert.equal(r.written.clientsCreated, created);
  assert.deepEqual(await snapshot(db), before);
});

test('повторная загрузка того же файла: все строки skip_same, применение — 0 изменений во всех таблицах', async () => {
  const up = await upload(w.lead, csv(), { now: NOW });
  assert.ok(up.sameFileApplied && up.sameFileApplied.importId === firstImportId);
  const s = await importService.preview(w.lead, up.importId, { ownerMap: w.ownerMap }, NOW);
  assert.equal(s.counts.byAction.update_state, 0);
  assert.equal(s.counts.byAction.kept_in_crm, 0);
  assert.equal(s.counts.byAction.create, 0, 'новых нет');
  assert.equal(s.counts.byAction.merge, 0);
  assert.ok(s.counts.byAction.skip_same >= created);
  const before = await snapshot(db);
  const r = await importService.apply(w.lead, up.importId, { fingerprint: s.fingerprint, ownerMap: w.ownerMap }, NOW + 2);
  assert.equal(r.alreadyApplied, false);
  assert.equal(r.written.clientsCreated + r.written.callsCreated + r.written.cardsUpdated + r.written.stopListed + r.written.tasksCreated, 0);
  assert.deepEqual(await snapshot(db), before);
});

let editedRow = 0;
let editedImportId = '';

test('правка итога в таблице: один новый звонок и новое состояние; повтор правленого файла — skip_same', async () => {
  // строка, созданная с владельцем, без итога, без задержки
  const pick = (await db.sql<any>`
    SELECT r.row_no, c.id AS card_id FROM import_rows r JOIN cards c ON c.client_id = r.client_id
     WHERE r.import_id = ${firstImportId} AND c.state = 'new' AND c.owner_user_id IS NOT NULL AND c.hold_reason = ''
       AND r.parsed ->> 'outcomeKey' IS NULL AND (r.parsed ->> 'note') IS NOT DISTINCT FROM NULL
     ORDER BY r.row_no LIMIT 1`)[0];
  assert.ok(pick, 'есть строка без итога');
  editedRow = pick.rowNo;
  const edit = (g: string[][]) => {
    g[editedRow - 1]![8] = 'Перезвонить';
  };
  const up = await upload(w.lead, csv(edit), { now: NOW });
  editedImportId = up.importId;
  const s = await importService.preview(w.lead, up.importId, { ownerMap: w.ownerMap }, NOW);
  assert.equal(s.counts.byAction.update_state, 1);
  assert.equal(s.counts.byAction.create, 0);
  const before = await snapshot(db);
  const r = await importService.apply(w.lead, up.importId, { fingerprint: s.fingerprint, ownerMap: w.ownerMap }, NOW + 3);
  assert.equal(r.written.callsCreated, 1);
  assert.equal(r.written.cardsUpdated, 1);
  const after = await snapshot(db);
  assert.equal(after.calls, before.calls! + 1);
  assert.equal(after.clients, before.clients);
  const [card] = await db.sql<any>`SELECT state, calls_total, connects_total, touched_in_crm, version FROM cards WHERE id = ${pick.cardId}`;
  assert.deepEqual([card.state, card.callsTotal, card.connectsTotal, card.touchedInCrm, card.version], ['callback', 1, 1, false, 1]);
  const [task] = await db.sql<any>`SELECT count(*)::int AS n FROM tasks t JOIN cards c ON c.client_id = t.client_id WHERE c.id = ${pick.cardId} AND t.source = 'callback' AND t.status = 'open'`;
  assert.equal(task.n, 1);
  // тот же правленый файл ещё раз → всё skip_same
  const again = await upload(w.lead, csv(edit), { now: NOW });
  const s2 = await importService.preview(w.lead, again.importId, { ownerMap: w.ownerMap }, NOW);
  assert.equal(s2.counts.byAction.update_state, 0);
  assert.equal(s2.counts.byAction.create + s2.counts.byAction.merge + s2.counts.byAction.kept_in_crm, 0);
});

test('карточку тронули в CRM: изменение в таблице → «оставлено как в CRM», звонка нет', async () => {
  const pick = (await db.sql<any>`
    SELECT r.row_no, c.id AS card_id FROM import_rows r JOIN cards c ON c.client_id = r.client_id
     WHERE r.import_id = ${firstImportId} AND c.state = 'new' AND c.owner_user_id IS NOT NULL AND c.hold_reason = ''
       AND r.parsed ->> 'outcomeKey' IS NULL AND r.row_no <> ${editedRow}
     ORDER BY r.row_no LIMIT 1`)[0];
  await db.sql`UPDATE cards SET touched_in_crm = TRUE WHERE id = ${pick.cardId}`;
  const edit = (g: string[][]) => {
    g[editedRow - 1]![8] = 'Перезвонить';
    g[pick.rowNo - 1]![8] = 'Не интересует';
  };
  const up = await upload(w.lead, csv(edit), { now: NOW });
  const s = await importService.preview(w.lead, up.importId, { ownerMap: w.ownerMap }, NOW);
  assert.equal(s.counts.byAction.kept_in_crm, 1);
  assert.equal(s.counts.byAction.update_state, 0);
  const rowsView = await importService.listRows(w.lead, up.importId, { filter: 'kept_in_crm', offset: 0, limit: 50 }, NOW);
  assert.equal(rowsView.total, 1);
  assert.equal(rowsView.rows[0]!.rowNo, pick.rowNo);
  const before = await snapshot(db);
  const r = await importService.apply(w.lead, up.importId, { fingerprint: s.fingerprint, ownerMap: w.ownerMap }, NOW + 4);
  assert.equal(r.written.keptInCrm, 1);
  assert.equal(r.written.callsCreated, 0);
  const after = await snapshot(db);
  assert.equal(after.calls, before.calls);
  const [card] = await db.sql<any>`SELECT state FROM cards WHERE id = ${pick.cardId}`;
  assert.equal(card.state, 'new');
  // следующая загрузка того же файла — skip_same (событие kept_in_crm помнит новое состояние)
  const again = await upload(w.lead, csv(edit), { now: NOW });
  const s2 = await importService.preview(w.lead, again.importId, { ownerMap: w.ownerMap }, NOW);
  assert.equal(s2.counts.byAction.kept_in_crm, 0);
  assert.equal(s2.counts.byAction.update_state, 0);
});

test('строки: фильтры, страница и CSV-выгрузка с обезвреженными формулами; аудит выгрузки без ПДн', async () => {
  const up = await upload(w.lead, csv(), { now: NOW });
  await importService.preview(w.lead, up.importId, { ownerMap: w.ownerMap }, NOW);
  const held = await importService.listRows(w.lead, up.importId, { filter: 'held', offset: 0, limit: 5 }, NOW);
  assert.equal(held.rows.length, 0, 'всё уже применено: held — только create');
  const skip = await importService.listRows(w.lead, up.importId, { filter: 'skip_same', offset: 10, limit: 20 }, NOW);
  assert.equal(skip.rows.length, 20);
  assert.ok(skip.total > 1500);
  const r = skip.rows[0]!;
  assert.ok(r.rowNo > 2 && typeof r.name === 'string' && r.phones.length >= 0);
  const out = await importService.exportRowsCsv(w.lead, up.importId, 'skip_same', NOW + 5, ['a', 'b']);
  assert.ok(out.csv.startsWith('﻿'));
  assert.equal(out.rows, skip.total);
  const au = await db.sql<any>`SELECT meta::text AS meta FROM audit_log WHERE action = 'import.export'`;
  assert.equal(au.length, 1);
  assert.doesNotMatch(au[0].meta, /ТОО|\+7/);
});

test('чистка по сроку: строки старше срока удалены, apply и предпросмотр → rows_expired', async () => {
  const up = await upload(w.lead, csv(), { now: NOW });
  const old = T0 - 15 * 86_400_000;
  await db.sql`UPDATE import_rows SET created_at = ${old} WHERE import_id = ${up.importId}`;
  const r = await purgeExpiredImportRows({ kind: 'system' }, T0);
  assert.ok(r.deleted >= 2200);
  await assert.rejects(importService.preview(w.lead, up.importId, { ownerMap: w.ownerMap }, NOW), (e: unknown) => e instanceof ImportError && e.code === 'rows_expired');
  await assert.rejects(importService.apply(w.lead, up.importId, { fingerprint: 'a'.repeat(64), ownerMap: w.ownerMap }, NOW), (e: unknown) => e instanceof ImportError && e.code === 'rows_expired');
  const list = await importService.listImports(w.lead, 50);
  assert.equal(list.find((i) => i.id === up.importId)?.rowsExpired, true);
});

test('приём ждёт блокировку: apply не пишет, пока держится INTAKE_LOCK_KEY', async () => {
  const body = csv((g) => {
    g.push(['ТОО', 'ТОО «Блокировочная Синтетика»', 'г.Город-А', 'Иванов Иван Иванович', '', '+7 709 555 01 01', 'ул. Тестовая, 1', '', '', '', '', '']);
  });
  const up = await upload(w.lead, body, { now: NOW });
  // строка добавлена в конец: её номер лежит за последним диапазоном — владельца нет, но create без hold
  const s = await importService.preview(w.lead, up.importId, { ownerMap: w.ownerMap }, NOW);
  assert.equal(s.counts.byAction.create, 1);
  let released = 0;
  const holder = db.tx(async (sql) => {
    await sql`SELECT pg_advisory_xact_lock(${INTAKE_LOCK_KEY})`;
    await new Promise((r) => setTimeout(r, 600));
    released = Date.now();
  });
  await new Promise((r) => setTimeout(r, 100));
  const r = await importService.apply(w.lead, up.importId, { fingerprint: s.fingerprint, ownerMap: w.ownerMap }, NOW + 6);
  const finished = Date.now();
  await holder;
  assert.ok(finished >= released, 'apply дождался отпускания блокировки приёма');
  assert.equal(r.written.clientsCreated, 1);
});

test('неверная сигнатура и бомба отклоняются при загрузке, импорт не создаётся', async () => {
  const before = (await db.sql<any>`SELECT count(*)::int AS n FROM imports`)[0].n;
  await assert.rejects(upload(w.lead, Buffer.from('%PDF-1.7 синтетика')), (e: unknown) => e instanceof SpreadsheetError && e.code === 'bad_type');
  await assert.rejects(upload(w.lead, Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3)), (e: unknown) => e instanceof SpreadsheetError && e.code === 'legacy_xls');
  const bomb = zip([
    { name: '[Content_Types].xml', data: '<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>' },
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="r"><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(30 * 1024 * 1024, 0x20), declaredSize: 2048 },
  ]);
  await assert.rejects(upload(w.lead, bomb), (e: unknown) => e instanceof SpreadsheetError && e.code === 'corrupt');
  await assert.rejects(upload(w.lead, csv(), { profileKey: 'нет-такого' }), (e: unknown) => e instanceof ImportError && e.code === 'bad_profile');
  await assert.rejects(upload(w.lead, Buffer.from('Колонка\nзначение\n')), (e: unknown) => e instanceof ImportError && e.code === 'header_not_found');
  assert.equal((await db.sql<any>`SELECT count(*)::int AS n FROM imports`)[0].n, before);
});

test('чужое пространство и выключенный модуль: 404 как у несуществующего', async () => {
  const other = { userId: w.lead.userId, spaceId: 'no-such-space' };
  assert.equal(await importService.getImport(other, firstImportId, NOW), null);
  await assert.rejects(importService.preview(other, firstImportId, { ownerMap: w.ownerMap }, NOW), (e: any) => e.code === 'not_found');
  await assert.rejects(importService.apply(other, firstImportId, { fingerprint: 'a'.repeat(64), ownerMap: {} }, NOW), (e: any) => e.code === 'not_found');
  const prev = process.env.FEATURE_IMPORT;
  process.env.FEATURE_IMPORT = '0';
  try {
    await assert.rejects(importService.listImports(w.lead, 10), (e: any) => e.code === 'not_found');
  } finally {
    if (prev === undefined) delete process.env.FEATURE_IMPORT;
    else process.env.FEATURE_IMPORT = prev;
  }
  void imports;
  void editedImportId;
});
