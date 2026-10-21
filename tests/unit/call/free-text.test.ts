// Свободный текст в итоге (D-293): заметка, данные ЛПР, текстовые поля, запись — такой итог не остаётся на телефоне
// при выходе без сети. Синтетика: «Берик Синтетик-ЛПР», +7 709 ….
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryHasFreeText, hasFreeText } from '../../../src/ui/call/freeText';

const base = { note: '', lprInfo: null, fields: {}, agreement: null };

test('коды и id — не текст: итог «Не берёт» без заметки', () => {
  assert.equal(hasFreeText(base), false);
  assert.equal(hasFreeText({ ...base, note: '   ' }), false);
  assert.equal(hasFreeText({ ...base, lprInfo: { name: ' ', phone: '', when: '' } }), false);
  assert.equal(hasFreeText({ ...base, agreement: { contactId: 'ct-1', agreedDueAt: 1, booking: null } }), false);
});

test('заметка, имя или номер ЛПР, запись внутри договорённости — текст', () => {
  assert.equal(hasFreeText({ ...base, note: 'Перезвонить после обеда' }), true);
  assert.equal(hasFreeText({ ...base, lprInfo: { name: 'Берик Синтетик-ЛПР', phone: '', when: '' } }), true);
  assert.equal(hasFreeText({ ...base, lprInfo: { name: '', phone: '+7 709 555 12 34', when: '' } }), true);
  assert.equal(hasFreeText({ ...base, agreement: { contactId: null, agreedDueAt: null, booking: { kind: 'group', eventId: 'ev-1' } as never } }), true);
});

test('поля итога: со списком текстовых полей — только они; без списка — любое непустое (с запасом)', () => {
  const r = { ...base, fields: { niche: 'retail', comment: '' } };
  assert.equal(hasFreeText(r, new Set(['comment'])), false, 'выбор из списка — не текст');
  assert.equal(hasFreeText({ ...r, fields: { niche: 'retail', comment: 'Синтетика' } }, new Set(['comment'])), true);
  assert.equal(hasFreeText(r), true, 'вид поля неизвестен — считаем текстом');
});

test('запись outbox: признак из записи важнее, без признака — проверка с запасом', () => {
  assert.equal(entryHasFreeText({ request: { ...base, fields: { niche: 'retail' } } as never, freeText: false }), false);
  assert.equal(entryHasFreeText({ request: { ...base, fields: { niche: 'retail' } } as never }), true);
  assert.equal(entryHasFreeText({ request: { ...base, note: 'x' } as never, freeText: true }), true);
});
