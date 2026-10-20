import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizers as n } from './testProfile';

test('splitPhones: рабочий номер, заглушка и обрывок', () => {
  const [ok, stub, short] = n.splitPhones('8 709 000 11 22; 7 709 000 00 00; 12345');
  assert.deepEqual([ok?.digits, ok?.kind, ok?.review], ['77090001122', 'mobile', false]);
  assert.equal(stub?.digits, null, 'заглушка нерабочая');
  assert.equal(short?.digits, null);
  assert.equal(n.splitPhones('8 770 000 00 01')[0]?.review, true); // префикс 770 — номер заведомо невыданный
});

test('legalFormOf: колонка «Тип» главнее и тоже приводится к коду, иначе код из названия', () => {
  const f = (t: string, name: string) => n.legalFormOf(t, name);
  assert.deepEqual(f(' ИП ', 'ТОО Что-то'), { code: 'ип', typeUnknown: false });
  assert.deepEqual(f('Индивидуальный предприниматель', 'Что-то'), { code: 'ип', typeUnknown: false });
  assert.deepEqual(f('Жеке кәсіпкер', 'Что-то'), { code: 'ип', typeUnknown: false });
  assert.deepEqual(f('ЖК', 'Что-то'), { code: 'ип', typeUnknown: false });
  assert.deepEqual(f('', 'Индивидуальный предприниматель Альфа'), { code: 'ип', typeUnknown: false });
  assert.deepEqual(f('', 'ТОО «Альфа»'), { code: 'тоо', typeUnknown: false });
  assert.deepEqual(f('', 'ЖК «Альфа Парк»'), { code: '', typeUnknown: false }, '«ЖК» в названии — жилой комплекс');
  assert.deepEqual(f('', 'Альфа'), { code: '', typeUnknown: false });
  assert.deepEqual(f('Что-то своё', 'ТОО Альфа'), { code: 'тоо', typeUnknown: true });
});

test('имена, ФИО и БИН', () => {
  assert.equal(n.normalizeName('ТОО «Альфа-Қала»'), 'альфа кала');
  assert.equal(n.normalizePerson('Ёлкин  Ә.'), 'елкин а');
  assert.equal(n.normalizeOrgId('123456 789012'), '123456789012');
  assert.equal(n.normalizeOrgId('12345'), null);
});
