import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizers as n } from './testProfile';

test('splitPhones: рабочий номер, заглушка и обрывок', () => {
  const [ok, stub, short] = n.splitPhones('8 709 000 11 22; 7 700 111 11 11; 12345');
  assert.deepEqual([ok?.digits, ok?.kind, ok?.review], ['77090001122', 'mobile', false]);
  assert.equal(stub?.digits, null, 'заглушка нерабочая');
  assert.equal(short?.digits, null);
  assert.equal(n.splitPhones('8 770 000 11 22')[0]?.review, true);
});

test('legalFormOf: колонка «Тип» главнее, иначе короткий код из названия', () => {
  assert.equal(n.legalFormOf(' ИП ', 'Что-то'), 'ип');
  assert.equal(n.legalFormOf('', 'Индивидуальный предприниматель Альфа'), 'ип');
  assert.equal(n.legalFormOf('', 'ТОО «Альфа»'), 'тоо');
  assert.equal(n.legalFormOf('', 'Альфа'), '');
});

test('имена, ФИО и БИН', () => {
  assert.equal(n.normalizeName('ТОО «Альфа-Қала»'), 'альфа кала');
  assert.equal(n.normalizePerson('Ёлкин  Ә.'), 'елкин а');
  assert.equal(n.normalizeOrgId('123456 789012'), '123456789012');
  assert.equal(n.normalizeOrgId('12345'), null);
});
