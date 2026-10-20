// Сценарии импорта из tests/fixtures/import/README.md на синтетических таблицах.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBookingIndex } from './bookings';
import { buildPreview, type PreviewInput } from './preview';
import type { PriorImportRow } from './reimport';
import { generateSyntheticSheets } from './syntheticSheets';
import { DEFAULT_DEDUP_SETTINGS, normalizers, parseOrThrow, testHash, testProfile } from './testProfile';
import type { ParsedRow } from './types';

const sheets = generateSyntheticSheets({ seed: 1 });
const profile = testProfile(sheets.slots);
const { rows } = parseOrThrow(sheets.main, profile);
const hashPhone = (d: string) => `hmac:${d}`;

function input(over: Partial<PreviewInput> = {}): PreviewInput {
  return {
    rows,
    profile,
    ownerMap: sheets.ownerMap,
    known: [],
    dedup: DEFAULT_DEDUP_SETTINGS,
    stopList: { hash: hashPhone, lookup: new Set<string>() },
    ...over,
  };
}
const priorOf = (rs: readonly ParsedRow[], touched = false): Map<string, PriorImportRow> =>
  new Map(rs.map((r) => [r.rowKey, { rowKey: r.rowKey, stateKey: r.stateKey, touchedInCrm: touched }]));

test('первый предпросмотр: все строки учтены, у каждого оператора своя доля, итоги сходятся', () => {
  const p = buildPreview(input());
  const c = p.counts;
  assert.equal(c.total, 2200);
  assert.equal(Object.values(c.byAction).reduce((a, b) => a + b, 0), 2200);
  assert.equal(c.byAction.invalid, 0);
  assert.equal(c.byAction.duplicate_in_file, 0);
  assert.equal(c.byAction.create + c.byAction.merge, 2200);
  assert.ok(c.byAction.create > 2100, 'разные компании с общим номером не склеиваются');
  const ops = Object.keys(sheets.ownerMap).length;
  assert.equal(Object.keys(p.perOperator).length, ops);
  // новые без hold = сумма по операторам + без владельца
  const free = p.rows.filter((r) => r.action === 'create' && !r.hold).length;
  assert.equal(free, Object.values(p.perOperator).reduce((a, b) => a + b, 0) + p.unowned);
  assert.equal(p.unowned, 0, 'все строки лежат в каких-то диапазонах');
  assert.deepEqual(p.unmappedSlots, []);
});

test('сценарий 1: повторная загрузка того же файла — 0 изменений', () => {
  const first = buildPreview(input());
  const created = rows.filter((_, i) => first.rows[i]?.action === 'create' || first.rows[i]?.action === 'merge');
  const again = buildPreview(input({ prior: priorOf(created) }));
  assert.equal(again.counts.byAction.skip_same, created.length);
  assert.equal(again.counts.byAction.create, 0);
  assert.equal(again.counts.byAction.update_state, 0);
  assert.equal(again.counts.byAction.kept_in_crm, 0);
  assert.deepEqual(again.perOperator, {});
});

test('сценарий 2: правка «Ответа» в одной строке — одна строка «обновить состояние»; если вели в CRM — «оставлено как в CRM»', () => {
  const edited = structuredClone(sheets.main);
  const target = 10;
  const row = edited[target - 1] as string[];
  row[8] = row[8] === 'Перезвонить' ? 'Не интересует' : 'Перезвонить';
  const { rows: rows2 } = parseOrThrow(edited, profile);
  const old = priorOf(rows);
  const p = buildPreview(input({ rows: rows2, prior: old }));
  assert.equal(p.counts.byAction.update_state, 1);
  assert.equal(p.counts.byAction.skip_same, 2199);
  assert.equal(p.rows.find((r) => r.action === 'update_state')?.rowNo, target);

  const touched = new Map(old);
  const key = rows2[target - 3]!.rowKey;
  touched.set(key, { ...touched.get(key)!, touchedInCrm: true });
  const p2 = buildPreview(input({ rows: rows2, prior: touched }));
  assert.equal(p2.counts.byAction.kept_in_crm, 1);
  assert.equal(p2.counts.byAction.update_state, 0);
  assert.equal(p2.rows.find((r) => r.action === 'kept_in_crm')?.rowNo, target);
});

test('сценарий 2б: дата снимка, файл «Обработанные» — копия: расходится ≈ 10 %, остальное пропускается', () => {
  const { rows: proc } = parseOrThrow(sheets.processed, profile);
  const p = buildPreview(input({ rows: proc, prior: priorOf(rows) }));
  assert.equal(p.counts.byAction.update_state, sheets.meta.processedChangedRows.length);
  assert.equal(p.counts.byAction.skip_same, proc.length - sheets.meta.processedChangedRows.length);
  assert.equal(p.counts.byAction.create, 0, 'копия не плодит новых клиентов: ключ строки без имени файла');
});

test('сценарий 3: «Подтвержден» без записи помечается; с записью из профиля «Записи» — нет', () => {
  const none = buildPreview(input());
  const agreed = none.rows.filter((r) => r.outcomeKey === 'agreed' && r.action === 'create');
  assert.ok(agreed.length > 20);
  assert.equal(none.counts.agreedWithoutBooking, agreed.length);
  assert.ok(agreed.every((r) => r.agreedWithoutBooking));

  const bookedPhones = sheets.meta.bookedRows.flatMap((n) => rows[n - 3]!.workingPhones);
  const withBookings = buildPreview(input({ bookings: createBookingIndex([{ phones: bookedPhones }]) }));
  const booked = new Set(sheets.meta.bookedRows);
  const expected = agreed.filter((r) => !booked.has(r.rowNo)).length;
  assert.equal(withBookings.counts.agreedWithoutBooking, expected);
  assert.ok(expected < agreed.length);
});

test('сценарий 4: пересечение диапазонов операторов — «Спорные из импорта» (hold import_conflict)', () => {
  const p = buildPreview(input());
  const overlap = p.rows.filter((r) => sheets.overlapRows.includes(r.rowNo));
  assert.equal(overlap.length, 100);
  assert.ok(overlap.every((r) => r.ownerKind === 'conflict' || r.action !== 'create'));
  const held = overlap.filter((r) => r.action === 'create');
  assert.ok(held.length >= 95);
  assert.ok(held.every((r) => r.holds.includes('import_conflict') && r.ownerUserId === null));
  assert.equal(p.counts.held.import_conflict, held.length);
  // одна учётка на оба слота снимает конфликт
  const [a, b] = sheets.slots.slice(0, 2).map((s) => s.label) as [string, string];
  const merged = buildPreview(input({ ownerMap: { ...sheets.ownerMap, [b]: sheets.ownerMap[a]! } }));
  assert.equal(merged.counts.held.import_conflict, 0);
});

test('слот без учётки: строки на разбор, слот назван в предпросмотре', () => {
  const [first, ...rest] = Object.entries(sheets.ownerMap);
  const p = buildPreview(input({ ownerMap: Object.fromEntries(rest) }));
  assert.ok(p.unmappedSlots.includes(first![0]));
  assert.ok(p.counts.held.import_conflict > 0);
  assert.equal(p.perOperator[first![1]], undefined);
});

test('сценарий 5: общий номер у двух ТОО с разными названиями — спорная пара, не склейка', () => {
  const p = buildPreview(input());
  let checked = 0;
  for (const g of sheets.meta.sharedPhoneGroups) {
    const later = g.slice(1);
    for (const n of later) {
      const r = p.rows[n - 3]!;
      assert.equal(r.action, 'create', `строка ${n}`);
      assert.ok(r.holds.includes('dup_pair'), `строка ${n}`);
      assert.ok(r.pairs.length >= 1 && r.pairs.every((x) => x.reason === 'shared_phone'));
      checked++;
    }
  }
  assert.equal(checked, 46);
  // пара не делится: спорные карточки не идут в раздачу — они в perOperator не входят
  assert.equal(p.counts.held.dup_pair >= 46, true);
});

test('одинаковые названия: пара только при том же руководителе (PROCESS 2.3 п. 4)', () => {
  const p = buildPreview(input());
  for (const [a, b] of sheets.meta.sameNamePairs) {
    const ra = rows[a - 3]!;
    const rb = rows[b - 3]!;
    assert.equal(ra.nameNorm, rb.nameNorm);
    const pb = p.rows[b - 3]!;
    assert.equal(pb.action, 'create');
    if (ra.headNorm === rb.headNorm) assert.ok(pb.pairs.some((x) => x.reason === 'name_and_head'));
    else assert.ok(!pb.holds.includes('dup_pair') || pb.pairs.every((x) => x.reason === 'shared_phone'));
  }
});

test('сценарий 6: ИП задержан правилом — создаётся, но не раздаётся; 12 цифр только как личный номер', () => {
  const p = buildPreview(input({ rules: { hold: [{ code: 'sole_trader', type: 'legalFormIn', values: ['ип'] }] } }));
  const ip = new Set(sheets.meta.sole.ip);
  const ipRows = p.rows.filter((r) => ip.has(r.rowNo));
  assert.ok(ipRows.length > 300);
  assert.ok(ipRows.filter((r) => r.action === 'create').every((r) => r.hold === 'rule' || r.holds.includes('rule')));
  assert.equal(p.rows.filter((r) => !ip.has(r.rowNo) && r.holds.includes('rule')).length, 0);
  assert.ok(ipRows.filter((r) => r.action === 'create').every((r) => !r.ownerUserId || r.hold !== ''));
  const free = Object.values(p.perOperator).reduce((a, b) => a + b, 0);
  assert.ok(free < p.counts.byAction.create - 300);
});

test('rejectRules: запись не сохраняется вовсе', () => {
  const p = buildPreview(input({ rules: { reject: [{ code: 'legal_review', type: 'legalFormIn', values: ['ип'] }] } }));
  assert.equal(p.counts.byAction.rejected_rule, sheets.meta.sole.ip.length);
});

test('стоп-лист: строка без остатка рабочих номеров не создаётся; частично — номер отброшен', () => {
  const single = rows.find((r) => r.workingPhones.length === 1 && !sheets.meta.sharedPhoneGroups.flat().includes(r.rowNo))!;
  const stop = new Set([hashPhone(single.workingPhones[0]!)]);
  const p = buildPreview(input({ stopList: { hash: hashPhone, lookup: stop } }));
  assert.equal(p.rows[single.rowNo - 3]?.action, 'stop_list');
  assert.equal(p.counts.byAction.stop_list, 1);

  const twoRow = rows[sheets.meta.twoPhonesRows[0]! - 3]!;
  assert.equal(twoRow.workingPhones.length, 2);
  const half = buildPreview(input({ stopList: { hash: hashPhone, lookup: new Set([hashPhone(twoRow.workingPhones[0]!)]) } }));
  assert.equal(half.rows[twoRow.rowNo - 3]?.action, 'create');
  assert.equal(half.rows[twoRow.rowNo - 3]?.stoppedPhones, 1);
});

test('без рабочего номера: клиент создаётся, но уходит в «Без рабочего номера» и не раздаётся', () => {
  const p = buildPreview(input());
  const stubRow = p.rows[sheets.meta.stubPhoneRows[0]! - 3]!;
  assert.equal(stubRow.action, 'create');
  assert.ok(stubRow.holds.includes('no_working_phone'));
  assert.equal(stubRow.ownerUserId === null || stubRow.hold !== '', true);
  assert.ok(p.counts.held.no_working_phone >= sheets.meta.stubPhoneRows.length + sheets.meta.badLengthRows.length);
});

test('известный клиент в базе: точный дубль — merge, спорный — пара', () => {
  const r0 = rows[0]!;
  const r1 = rows[1]!;
  const known = [
    { id: 'c1', createdAt: 1, orgId: null, phones: r0.workingPhones, nameNorm: r0.nameNorm, headNorm: r0.headNorm },
    { id: 'c2', createdAt: 2, orgId: null, phones: r1.workingPhones, nameNorm: 'совсем другое', headNorm: '' },
  ];
  const p = buildPreview(input({ known }));
  assert.equal(p.rows[0]?.action, 'merge');
  assert.equal(p.rows[0]?.matchId, 'c1');
  assert.equal(p.rows[1]?.action, 'create');
  assert.deepEqual(p.rows[1]?.pairs, [{ id: 'c2', reason: 'shared_phone' }]);
});

test('дубль строки внутри файла: вторая отбрасывается', () => {
  const grid = [...sheets.main.slice(0, 5), sheets.main[2] as string[]];
  const { rows: r } = parseOrThrow(grid, profile);
  const p = buildPreview(input({ rows: r }));
  assert.equal(p.rows[3]?.action, 'duplicate_in_file');
});

test('метки заметок и замечания попадают в счётчики предпросмотра', () => {
  const p = buildPreview(input());
  assert.equal(p.counts.noteFlags['dnc_request'], sheets.meta.dncNoteRows.length);
  assert.equal(p.counts.noteFlags['sensitive'], sheets.meta.sensitiveNoteRows.length);
  assert.equal(p.counts.noteFlags['date_in_note'], sheets.meta.dateNoteRows.length);
  assert.ok(p.counts.needReview >= sheets.meta.contradictionRows.length);
});

test('отчёт предпросмотра не содержит ПДн: только номера строк, коды и id', () => {
  const p = buildPreview(input());
  const text = JSON.stringify(p);
  assert.equal(/\+7|7709\d{7}/.test(text), false);
  for (const r of rows.slice(0, 50)) assert.equal(text.includes(r.name), false);
});

test('порядок результата стабилен: то же в тех же условиях', () => {
  assert.deepEqual(buildPreview(input()), buildPreview(input()));
  void normalizers;
  void testHash;
});
