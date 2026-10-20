import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileMaps, isContradiction, parseAnswerCell, parseLpr, parseTarget } from './answer';
import { detectDelimiter, parseCsv, parseCsvRecords, toCsv } from './csv';
import { importKeyOf, squashSpaces } from './keys';
import { parseOperatorRules, resolveOwner, resolveRowOwner, ruleOverlaps } from './owner';
import { compileProfile, parseSheet } from './parse';
import { decideReimport } from './reimport';
import { createBookingIndex, hasBooking } from './bookings';
import { orgKeyOf, redactPersonalId } from './personalId';
import { buildPreview } from './preview';
import { generateSyntheticSheets } from './syntheticSheets';
import { DEFAULT_DEDUP_SETTINGS, normalizers, parseOrThrow, testHash, testProfile } from './testProfile';

const slots = [
  { label: 'Оператор-01 (Синий)', name: 'Оператор-01', color: 'Синий', ranges: [[3, 202]] as [number, number][] },
  { label: 'Оператор-02 (Зелёный)', name: 'Оператор-02', color: 'Зелёный', ranges: [[203, 402], [1653, 1702]] as [number, number][] },
  { label: 'Оператор-03 (Жёлтый)', name: 'Оператор-03', color: 'Жёлтый', ranges: [[1603, 1802]] as [number, number][] },
];
const profile = testProfile(slots);
const maps = compileMaps(profile);

// --- CSV ---

test('CSV: переводы строк и кавычки внутри ячейки не сдвигают номера строк', () => {
  const rows = parseCsvRecords('title,,\nA,B,C\n1,"line1\nline2",x\n2,"a ""q""",y\n');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[2], ['1', 'line1\nline2', 'x']);
  assert.deepEqual(rows[3], ['2', 'a "q"', 'y']);
});

test('CSV: BOM, CRLF и разделитель «;» определяются сами; toCsv обратим', () => {
  assert.deepEqual(parseCsvRecords('﻿a;b\r\n1;2\r\n'), [['a', 'b'], ['1', '2']]);
  const grid = [['x', 'a,b', 'c"d'], ['1\n2', '', ' пробел ']];
  assert.deepEqual(parseCsvRecords(toCsv(grid)), grid);
});

test('CSV: разделитель — по строке заголовков, а не по баннеру с запятыми', () => {
  const text = 'Таблица обзвона, октябрь, город Пример\nТип;Наименование;Телефон\nТОО;Альфа, Бета;+7 709 000 70 01\n';
  assert.deepEqual(parseCsvRecords(text, { headers: Object.keys(profile.columns) })[2], ['ТОО', 'Альфа, Бета', '+7 709 000 70 01']);
  // Без подсказки — разделитель, которого больше всего в одной строке.
  const wide = 'Выгрузка, октябрь\nТип;Наименование;Телефон;Ответ\n';
  assert.equal(detectDelimiter(wide), ';');
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
});

test('CSV: непарная кавычка не съедает файл — ошибка строки, номера строк не едут', () => {
  // Кавычка в середине ячейки — обычный символ.
  const mid = parseCsv('a,b\nТОО "Альфа,x\nc,d\n');
  assert.deepEqual(mid.rows, [['a', 'b'], ['ТОО "Альфа', 'x'], ['c', 'd']]);
  assert.deepEqual(mid.errors, []);
  // Кавычка в начале ячейки без пары до конца файла.
  const eof = parseCsv('a,b\n"Альфа,x\nc,d\ne,f\n');
  assert.deepEqual(eof.rows, [['a', 'b'], ['"Альфа', 'x'], ['c', 'd'], ['e', 'f']]);
  assert.deepEqual(eof.errors, [{ rowNo: 2, code: 'bad_quote' }]);
  // Непарная кавычка «закрылась» кавычкой следующей строки — откат, строки на месте.
  const pair = parseCsv('a,b\n"Альфа,x\n"Бета",y\nc,d\n');
  assert.deepEqual(pair.rows, [['a', 'b'], ['"Альфа', 'x'], ['Бета', 'y'], ['c', 'd']]);
  assert.deepEqual(pair.errors, [{ rowNo: 2, code: 'bad_quote' }]);
  // Слишком длинная кавычечная ячейка — тоже откат.
  const long = parseCsv(`a,b\n"x,1\n${'r,2\n'.repeat(40)}`, { maxCellLines: 30 });
  assert.equal(long.rows.length, 42);
  assert.deepEqual(long.errors, [{ rowNo: 2, code: 'bad_quote' }]);
  // Правильные кавычки с переводами строк и пробелом после закрывающей — без ошибок.
  const ok = parseCsv('a,b\n"line1\nline2" ,x\n');
  assert.deepEqual(ok.rows, [['a', 'b'], ['line1\nline2 ', 'x']]);
  assert.deepEqual(ok.errors, []);
  assert.equal(parseCsv('a,"').errors.length, 1);
});

// --- итоги ---

test('итог в ячейке: множественный выбор берётся по приоритету PROCESS 3.7', () => {
  const p = (c: string) => parseAnswerCell(c, maps);
  assert.equal(p('Отключен/Не берет').primary, 'no_answer');
  assert.deepEqual(p('Отключен/Не берет, Перезвонить').values.map((v) => v.outcomeKey), ['no_answer', 'callback']);
  assert.equal(p('Отключен/Не берет, Перезвонить').primary, 'callback', 'Перезвонить выше «Не берёт»');
  assert.equal(p('Недоступен, Перезвонить').primary, 'bad_number', 'Недоступен выше «Перезвонить»');
  assert.equal(p('Перезвонить, Не имеет отношение').primary, 'bad_number');
  assert.equal(p('Не интересует, Не имеет отношение').primary, 'not_interested');
  assert.equal(p('Подтвержден, Не интересует').primary, 'agreed');
  assert.equal(p('Закрылся, Подтвержден').primary, 'not_target');
  assert.equal(p('Закрылся, Полный отказ').primary, 'do_not_call');
  assert.equal(p('  перезвонить  ').primary, 'callback', 'регистр и пробелы не важны');
  assert.equal(p('').primary, null);
});

test('итог: исходный текст сохраняется, неизвестное значение не угадывается', () => {
  const a = parseAnswerCell('Перезвонить, что-то новое', maps);
  assert.equal(a.raw, 'Перезвонить, что-то новое');
  assert.deepEqual(a.unknown, ['что-то новое']);
  assert.equal(a.primary, 'callback');
  assert.deepEqual(parseAnswerCell('Перезвонить, перезвонить', maps).values.length, 1, 'повтор значения схлопывается');
});

test('итог: ключи вне приоритета уступают перечисленным; среди них — порядок ячейки', () => {
  const m = compileMaps(testProfile(slots, { outcomePriority: ['callback'] }));
  assert.equal(parseAnswerCell('Закрылся, Перезвонить', m).primary, 'callback');
  assert.equal(parseAnswerCell('Закрылся, Подтвержден', m).primary, 'not_target');
});

test('ЛПР и статус: пусто ≠ «Нет»; мусор → null (на разбор)', () => {
  assert.equal(parseLpr('', maps), '');
  assert.equal(parseLpr(' Да ', maps), 'yes');
  assert.equal(parseLpr('Нет', maps), 'no');
  assert.equal(parseLpr('возможно', maps), null);
  assert.equal(parseTarget('', maps), '');
  assert.equal(parseTarget('Не целевой', maps), 'non_target');
  assert.equal(parseTarget('Целевой', maps), 'target');
  assert.equal(parseTarget('не знаю', maps), null);
});

test('противоречия статуса и итога', () => {
  assert.equal(isContradiction('target', 'not_target'), true);
  assert.equal(isContradiction('target', 'do_not_call'), true);
  assert.equal(isContradiction('non_target', 'agreed'), true);
  assert.equal(isContradiction('target', 'callback'), false);
  assert.equal(isContradiction('', 'agreed'), false, 'пустой статус не выводится догадкой');
  assert.equal(isContradiction('non_target', null), false);
});

// --- владелец ---

const RULES_GRID = [
  ['Цветовой маркер', 'Оператор', 'Диапазон строк', 'Количество'],
  ['Розовый', 'Оператор-01', 'Строки 3 – 202', '200'],
  ['Синий', 'Оператор-02', 'Строки 203 – 402, 1653-1702', '200'],
  ['Зелёный', 'Оператор-03', 'Строки 1603 – 1802', '200'],
  ['ИТОГО', '3 оператора', 'Строки 3 – 1802', '600'],
];

test('правила операторов: слот на строку таблицы, пересечения видны до сопоставления', () => {
  const s = parseOperatorRules(RULES_GRID);
  assert.deepEqual(s.map((x) => x.label), ['Оператор-01 (Розовый)', 'Оператор-02 (Синий)', 'Оператор-03 (Зелёный)']);
  assert.deepEqual(s[1]?.ranges, [[203, 402], [1653, 1702]]);
  assert.deepEqual(ruleOverlaps(s), [{ from: 1653, to: 1702, slots: ['Оператор-02 (Синий)', 'Оператор-03 (Зелёный)'] }]);
});

test('владелец строки: пересечение без угадывания; одна учётка на оба слота — не конфликт', () => {
  const map = { 'Оператор-01 (Синий)': 'u1', 'Оператор-02 (Зелёный)': 'u2', 'Оператор-03 (Жёлтый)': 'u3' };
  assert.deepEqual(resolveRowOwner(10, slots, map), { kind: 'assigned', userId: 'u1', slots: ['Оператор-01 (Синий)'], blockNo: 1 });
  assert.equal(resolveRowOwner(1660, slots, map).kind, 'conflict');
  assert.equal(resolveRowOwner(1660, slots, { ...map, 'Оператор-03 (Жёлтый)': 'u2' }).kind, 'assigned');
  assert.equal(resolveRowOwner(1660, slots, { 'Оператор-02 (Зелёный)': 'u2' }).kind, 'conflict', 'без учётки у второго слота');
  assert.deepEqual(resolveRowOwner(5000, slots, map), { kind: 'no_rule' });
  assert.deepEqual(resolveRowOwner(300, slots, {}), { kind: 'unmapped', slots: ['Оператор-02 (Зелёный)'] });
  assert.equal((resolveRowOwner(1660, slots, { ...map, 'Оператор-03 (Жёлтый)': 'u2' }) as { blockNo: number }).blockNo, 2);
});

test('владелец из колонки «оператор»', () => {
  const by = { kind: 'column' } as const;
  assert.deepEqual(resolveOwner(5, 'Оператор-01', by, { 'оператор-01': 'u1' }), { kind: 'assigned', userId: 'u1', slots: ['Оператор-01'], blockNo: 1 });
  assert.equal(resolveOwner(5, 'Другой', by, { 'оператор-01': 'u1' }).kind, 'unmapped');
  assert.equal(resolveOwner(5, '', by, {}).kind, 'no_rule');
});

// --- разбор таблицы ---

const HEAD = ['Тип', 'Наименование', 'Регион', 'Руководитель', 'ОКЭД', 'Телефон', 'Адрес', 'ЛПР подтвержден', 'Ответ', 'Статус', 'Точная ниша', 'Заметка'];
const line = (o: Partial<Record<string, string>>): string[] => HEAD.map((h) => o[h] ?? '');

test('разбор: баннер пропускается, строки нумеруются как в файле (данные с 3-й)', () => {
  const { rows } = parseOrThrow(
    [['Выгрузка'], HEAD, line({ Наименование: 'ТОО «Альфа»', Телефон: '+7 709 111 22 33', Ответ: 'Перезвонить' }), line({}), line({ Наименование: 'ТОО «Бета»', Телефон: '8 709 111 22 44' })],
    profile,
  );
  assert.deepEqual(rows.map((r) => r.rowNo), [3, 5]);
  assert.equal(rows[0]?.outcomeKey, 'callback');
  assert.deepEqual(rows[1]?.workingPhones, ['77091112244']);
});

test('разбор: заголовки не найдены → ошибка, а не молчаливый пропуск', () => {
  const r = parseSheet([['a', 'b'], ['1', '2']], compileProfile(profile), { normalizers, hash: testHash });
  assert.deepEqual(r, { ok: false, error: 'header_not_found', missing: [] });
  const noPhones = compileProfile(testProfile(slots, { columns: { Наименование: 'name' } }));
  const r2 = parseSheet([['Наименование'], ['x']], noPhones, { normalizers, hash: testHash });
  assert.equal(r2.ok, false);
  assert.deepEqual(!r2.ok && r2.missing, ['phones']);
});

test('разбор: замечания строки — неизвестный итог, мусорный статус, противоречие, метки заметки', () => {
  const { rows } = parseOrThrow(
    [HEAD, line({ Наименование: 'А', Телефон: '+7 709 111 22 33', Ответ: 'Что-то', Статус: 'не знаю', 'ЛПР подтвержден': '?' }),
      line({ Наименование: 'Б', Телефон: '+7 709 111 22 34', Ответ: 'Закрылся', Статус: 'Целевой', Заметка: 'просил не звонить, набрать 14.10' }),
      line({ Наименование: 'В', Телефон: '+7 770 111 22 35', Руководитель: 'Иванов2' })],
    profile,
  );
  assert.deepEqual(rows[0]?.issues.map((i) => i.code), ['unknown_answer', 'unknown_lpr', 'unknown_status']);
  assert.equal(rows[0]?.issues[0]?.detail, 'Что-то');
  assert.ok(rows[1]?.issues.some((i) => i.code === 'contradiction'));
  assert.deepEqual(rows[1]?.noteFlags, ['dnc_request', 'date_in_note']);
  assert.ok(rows[1]?.issues.some((i) => i.code === 'note_dnc_request'));
  assert.ok(rows[2]?.issues.some((i) => i.code === 'phone_review'));
  assert.ok(rows[2]?.issues.some((i) => i.code === 'head_has_digits'));
});

test('разбор: строка без названия — ошибка; заглушка и пустой номер — без рабочих номеров', () => {
  const { rows } = parseOrThrow(
    [HEAD, line({ Телефон: '+7 709 111 22 33' }), line({ Наименование: 'Г', Телефон: '+7 799 999 99 99' }), line({ Наименование: 'Д' })],
    profile,
  );
  assert.equal(rows[0]?.issues[0]?.code, 'no_name');
  assert.deepEqual(rows[1]?.workingPhones, []);
  assert.deepEqual(rows[1]?.stubPhones, ['77999999999']);
  assert.ok(rows[1]?.issues.some((i) => i.code === 'no_working_phone'));
  assert.ok(rows[2]?.issues.some((i) => i.code === 'no_phone'));
});

test('ИП: форма определяется по названию, 12 цифр помечаются как личные', () => {
  const { rows } = parseOrThrow(
    [[...HEAD, 'БИН'], [...line({ Наименование: 'ИП Сидоров Сидор', Телефон: '+7 709 111 22 33' }), '123456789012']],
    testProfile(slots, { columns: { ...profile.columns, БИН: 'orgId' } }),
  );
  assert.equal(rows[0]?.legalForm, 'ип');
  assert.equal(rows[0]?.orgId, '123456789012');
  assert.equal(rows[0]?.orgIdPersonal, true);
});

test('колонка «Тип»: каждая форма записи ИП даёт код «ип», личный ИИН и срабатывание правила (D-052)', () => {
  const p = testProfile(slots, { columns: { ...profile.columns, БИН: 'orgId' } });
  const forms = ['ИП', 'ип', 'ИП.', 'Индивидуальный предприниматель', 'ИНДИВИДУАЛЬНЫЙ ПРЕДПРИНИМАТЕЛЬ', 'ЖК', 'Жеке кәсіпкер', 'жеке касипкер', 'IP'];
  const grid = [[...HEAD, 'БИН'], ...forms.map((t, i) => [...line({ Тип: t, Наименование: `Пример-${i}`, Телефон: `+7 709 000 10 ${10 + i}` }), '880101300123'])];
  const { rows } = parseOrThrow(grid, p);
  for (const [i, r] of rows.entries()) {
    assert.equal(r.legalForm, 'ип', forms[i]);
    assert.equal(r.orgIdPersonal, true, forms[i]);
    assert.equal(r.issues.some((x) => x.code === 'unknown_legal_form'), false, forms[i]);
  }
  const pv = buildPreview({
    rows, profile: p, ownerMap: {}, known: [], dedup: DEFAULT_DEDUP_SETTINGS, personalIdHmac: (d) => `h${d.length}`,
    stopList: { hash: (d) => d, lookup: new Set() },
    rules: { reject: [{ code: 'legal_review', type: 'legalFormIn', values: ['ип'] }] },
  });
  assert.equal(pv.counts.byAction.rejected_rule, forms.length);
});

test('колонка «Тип»: ТОО и АО распознаются; неизвестное значение — на разбор, форма из названия, номер — «неуверенный» личный', () => {
  const p = testProfile(slots, { columns: { ...profile.columns, БИН: 'orgId' } });
  const { rows } = parseOrThrow(
    [
      [...HEAD, 'БИН'],
      [...line({ Тип: 'Товарищество с ограниченной ответственностью', Наименование: 'Альфа', Телефон: '+7 709 000 20 01' }), '990440000001'],
      [...line({ Тип: 'ЖШС', Наименование: 'Бета', Телефон: '+7 709 000 20 02' }), '990440000002'],
      [...line({ Тип: 'Форма-Икс', Наименование: 'ТОО Гамма', Телефон: '+7 709 000 20 03' }), '990440000003'],
      [...line({ Тип: '', Наименование: 'Дельта', Телефон: '+7 709 000 20 04' }), '990440000004'],
      [...line({ Тип: '', Наименование: 'ЖК «Альфа Парк»', Телефон: '+7 709 000 20 05' }), ''],
      [...line({ Тип: 'ИП', Наименование: 'Эпсилон', Телефон: '+7 709 000 20 08' }), '880101300123'],
    ],
    p,
  );
  assert.deepEqual(rows.map((r) => r.legalForm), ['тоо', 'тоо', 'тоо', '', '', 'ип']);
  assert.deepEqual(rows.map((r) => r.orgIdPersonal), [false, false, true, true, false, true]);
  // «Неуверенный» — только когда форма не определена; у ИП номер личный наверняка.
  assert.deepEqual(rows.map((r) => r.orgIdUncertain), [false, false, true, true, false, false]);
  assert.ok(rows[2]?.issues.some((x) => x.code === 'unknown_legal_form' && x.severity === 'review'));
  // Профиль может назвать «личную» форму полностью — признак тот же.
  const full = parseOrThrow([[...HEAD, 'БИН'], [...line({ Тип: 'ИП', Наименование: 'Пример', Телефон: '+7 709 000 20 06' }), '880101300123']],
    testProfile(slots, { columns: { ...profile.columns, БИН: 'orgId' }, personalIdForms: ['Индивидуальный предприниматель'] }));
  assert.equal(full.rows[0]?.orgIdPersonal, true);
  // Без «личных» форм в профиле признака нет вовсе.
  const none = parseOrThrow([[...HEAD, 'БИН'], [...line({ Наименование: 'Пример', Телефон: '+7 709 000 20 07' }), '990440000007']],
    testProfile(slots, { columns: { ...profile.columns, БИН: 'orgId' }, personalIdForms: [] }));
  assert.equal(none.rows[0]?.orgIdPersonal, false);
});

test('колонка «Тип»: ГКП, КХ, ГУ, ОО, ПК и «Т.О.О.» распознаются, «ТОО» в названии не перебивает «Тип» (D-141)', () => {
  const p = testProfile(slots, { columns: { ...profile.columns, БИН: 'orgId' } });
  const types = ['ГКП', 'КХ', 'ГУ', 'ОО', 'ПК', 'Т.О.О.', 'Крестьянское (фермерское) хозяйство', 'Государственное учреждение'];
  const grid = [[...HEAD, 'БИН'], ...types.map((t, i) => [...line({ Тип: t, Наименование: `ТОО Пример-${i}`, Телефон: `+7 709 000 40 ${10 + i}` }), `99044000004${i}`])];
  const { rows } = parseOrThrow(grid, p);
  assert.deepEqual(rows.map((r) => r.legalForm), ['гкп', 'кх', 'гу', 'оо', 'пк', 'тоо', 'кх', 'гу']);
  for (const [i, r] of rows.entries()) assert.equal(r.issues.some((x) => x.code === 'unknown_legal_form'), false, types[i]);
  // КХ — форма ИП (личный номер по профилю); остальные — юрлица: БИН открыт, «неуверенных» нет.
  assert.deepEqual(rows.map((r) => r.orgIdPersonal), [false, true, false, false, false, false, true, false]);
  assert.ok(rows.every((r) => !r.orgIdUncertain));
  // «ПК» — форма только в «Тип»: в названии это не форма.
  assert.equal(normalizers.normalizeName('Сервис ПК'), 'сервис пк');
  assert.equal(normalizers.normalizeName('Т.О.О. «Альфа»'), 'альфа');
});

test('redactPersonalId: открытого ИИН в строке для хранения нет, ключ iin:HMAC не хэшируется повторно', () => {
  const { rows } = parseOrThrow(
    [[...HEAD, 'БИН'], [...line({ Тип: 'ИП', Наименование: 'Пример', Телефон: '+7 709 000 30 01' }), '880101300123'],
      [...line({ Тип: 'ТОО', Наименование: 'Альфа', Телефон: '+7 709 000 30 02' }), '990440000001']],
    testProfile(slots, { columns: { ...profile.columns, БИН: 'orgId' } }),
  );
  const hmac = (d: string) => `mac-${d.length}`;
  const [ip, too] = rows.map((r) => redactPersonalId(r, hmac));
  assert.equal(ip?.orgId, 'iin:mac-12');
  assert.equal(JSON.stringify(ip).includes('880101300123'), false);
  assert.equal(orgKeyOf(ip!, hmac), 'iin:mac-12');
  assert.equal(too?.orgId, '990440000001', 'БИН не скрывается');
});

// --- ключи (D-048) ---

test('ключ строки не зависит от порядка номеров, регистра, формы собственности и пробелов', () => {
  const key = (o: Partial<Record<string, string>>) => parseOrThrow([HEAD, line(o)], profile).rows[0]?.rowKey;
  const a = key({ Наименование: 'Товарищество с ограниченной ответственностью «Альфа Бета»', Руководитель: 'Иванов Иван', Телефон: '+7 709 111 22 33, +7 709 111 22 34' });
  const b = key({ Наименование: 'ТОО «альфа  бета»', Руководитель: ' иванов  иван ', Телефон: '8 709 111 22 34; 8 709 111 22 33' });
  assert.equal(a, b);
  assert.notEqual(a, key({ Наименование: 'ТОО «Альфа Бета»', Руководитель: 'Иванов Иван', Телефон: '+7 709 111 22 33' }), 'другой набор номеров — другая строка');
  assert.ok(a?.startsWith('operator-tables:'));
});

test('общий номер у двух ТОО с разными названиями — разные ключи строк', () => {
  const { rows } = parseOrThrow([HEAD, line({ Наименование: 'Альфа', Телефон: '+7 709 111 22 33' }), line({ Наименование: 'Бета', Телефон: '+7 709 111 22 33' })], profile);
  assert.notEqual(rows[0]?.rowKey, rows[1]?.rowKey);
});

test('ключ состояния: правка итога меняет его, хвостовые пробелы заметки — нет; ключ строки тот же', () => {
  const r = (o: Partial<Record<string, string>>) => parseOrThrow([HEAD, line({ Наименование: 'Альфа', Телефон: '+7 709 111 22 33', ...o })], profile).rows[0]!;
  const base = r({ Ответ: 'Отключен/Не берет', Заметка: 'позвонить' });
  assert.equal(r({ Ответ: 'Отключен/Не берет', Заметка: '  позвонить ' }).stateKey, base.stateKey);
  const edited = r({ Ответ: 'Перезвонить', Заметка: 'позвонить' });
  assert.notEqual(edited.stateKey, base.stateKey);
  assert.equal(edited.rowKey, base.rowKey);
  for (const [field, v] of [['ЛПР подтвержден', 'Да'], ['Статус', 'Целевой'], ['Точная ниша', 'Ниша-А'], ['Заметка', 'другое']] as const) {
    assert.notEqual(r({ Ответ: 'Отключен/Не берет', Заметка: 'позвонить', [field]: v }).stateKey, base.stateKey, field);
  }
  assert.equal(importKeyOf(base.rowKey, base.stateKey), `${base.rowKey}:${base.stateKey}`);
  assert.equal(squashSpaces('  А   б '), 'а б');
  assert.equal(testHash('x'), testHash('x'));
});

test('решение при повторе: тот же ключ — пропуск; изменился — звонок или «оставлено как в CRM»', () => {
  const row = { stateKey: 's2' };
  assert.equal(decideReimport(row, undefined), 'new');
  assert.equal(decideReimport(row, { rowKey: 'k', stateKey: 's2', touchedInCrm: true }), 'skip');
  assert.equal(decideReimport(row, { rowKey: 'k', stateKey: 's1', touchedInCrm: false }), 'update_state');
  assert.equal(decideReimport(row, { rowKey: 'k', stateKey: 's1', touchedInCrm: true }), 'kept_in_crm');
});

test('индекс записей: по номеру или БИН', () => {
  const idx = createBookingIndex([{ phones: ['77091112233'] }, { phones: [], orgId: '123456789012' }]);
  assert.equal(hasBooking({ orgId: null, workingPhones: ['77091112233'] }, idx), true);
  assert.equal(hasBooking({ orgId: '123456789012', workingPhones: [] }, idx), true);
  assert.equal(hasBooking({ orgId: null, workingPhones: ['77090000000'] }, idx), false);
});

// --- синтетические таблицы ---

test('генератор: детерминирован, структура по README, без стоп-слов клиента', () => {
  const a = generateSyntheticSheets({ seed: 7, rows: 400 });
  const b = generateSyntheticSheets({ seed: 7, rows: 400 });
  assert.deepEqual(a.main, b.main);
  assert.notDeepEqual(a.main, generateSyntheticSheets({ seed: 8, rows: 400 }).main);
  assert.equal(a.main.length, 402);
  assert.equal(a.main[0]?.length, 1, 'баннер');
  assert.equal(a.main[1]?.length, 12);
  assert.ok(a.main.slice(2).every((r) => r.length === 12));
  const text = toCsv(a.main);
  // стоп-слова клиента собираются из частей, чтобы статический тест не срабатывал на самом тесте
  const stop = ['Ц' + 'РП', 'Аст' + 'ан', 'Б' + 'Р', 'Б' + 'К'].map((w) => new RegExp(`(?<![\\p{L}])${w}`, 'u'));
  assert.deepEqual(stop.filter((re) => re.test(text)).length, 0);
  assert.equal(parseCsvRecords(text).length, 402, 'CSV с переводами строк в ячейках читается обратно');
  assert.equal(a.processed.length - 2, Math.round(400 * (460 / 2200)));
});

test('генератор: дефекты из README находятся разбором ровно там, где внесены (2200 строк)', () => {
  const s = generateSyntheticSheets({ seed: 1 });
  const { rows } = parseOrThrow(s.main, testProfile(s.slots));
  assert.equal(rows.length, 2200);
  const rowsWith = (code: string) => rows.filter((r) => r.issues.some((i) => i.code === code)).map((r) => r.rowNo);
  assert.deepEqual(rowsWith('contradiction'), s.meta.contradictionRows);
  assert.equal(s.meta.contradictionRows.length, 57);
  assert.deepEqual(rowsWith('phone_review'), s.meta.reviewPrefixRows);
  assert.deepEqual(rowsWith('unknown_status'), s.meta.junkStatusRows);
  assert.deepEqual(rowsWith('note_dnc_request'), s.meta.dncNoteRows);
  assert.deepEqual(rowsWith('note_sensitive'), s.meta.sensitiveNoteRows);
  assert.deepEqual(rowsWith('many_phones'), s.meta.twoPhonesRows);
  assert.deepEqual(rowsWith('head_has_digits').length, 1);
  assert.deepEqual(rowsWith('no_phone'), s.meta.emptyPhoneRows);
  for (const r of s.meta.stubPhoneRows) assert.equal(rows[r - 3]?.workingPhones.length, 0, `заглушка в строке ${r}`);
  for (const r of s.meta.badLengthRows) assert.equal(rows[r - 3]?.workingPhones.length, 0, `не 11 цифр в строке ${r}`);
  assert.ok(s.meta.multiAnswerRows.length > 0.12 * 2200 * 0.49 && rows.filter((r) => r.answer.raw.includes(',')).length === s.meta.multiAnswerRows.length);
  assert.equal(rows.filter((r) => r.answer.unknown.length > 0).length, 0, 'все 8 значений ответа распознаны профилем');
  const ip = rows.filter((r) => r.legalForm === 'ип');
  assert.equal(ip.length, s.meta.sole.ip.length);
  assert.ok(ip.length > 300 && ip.length < 450);
  // ключ строки уникален, кроме совпадающих строк (их нет по построению)
  assert.equal(new Set(rows.map((r) => r.rowKey)).size, 2200);
  // общие номера: у групп один рабочий номер на несколько компаний, ключи разные
  assert.equal(s.meta.sharedPhoneGroups.length, 45);
  assert.equal(s.meta.sharedPhoneGroups[0]?.length, 3);
  for (const g of s.meta.sharedPhoneGroups) {
    const phones = g.map((r) => rows[r - 3]?.workingPhones[0]);
    assert.equal(new Set(phones).size, 1);
  }
});
