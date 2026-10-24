// Ввод поля на месте (D-356): разбор денег и номера, «сохранять ли», Esc, показ значения, переходы состояний.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commitsOnPick,
  displayValue,
  draftFor,
  isInlineType,
  maskPhone,
  parseMoney,
  parseNumber,
  parsePhoneInput,
  payloadFor,
  prepareSave,
  revertDraft,
  shouldSaveOnBlur,
  stateAfterSave,
  valueFromPayload,
} from '../../../src/ui/fields/inline';

test('деньги: «150 000» → 150000, копейки и мусор — ошибка', () => {
  assert.deepEqual(parseMoney('150 000'), { ok: true, value: 150000 });
  assert.deepEqual(parseMoney('150 000 ₸'), { ok: true, value: 150000 });
  assert.deepEqual(parseMoney(''), { ok: true, value: null });
  assert.deepEqual(parseMoney('1 500,50'), { ok: false, code: 'money' });
  assert.deepEqual(parseMoney('1500.5'), { ok: false, code: 'money' });
  assert.deepEqual(parseMoney('-5'), { ok: false, code: 'money' });
  assert.deepEqual(parseMoney('abc'), { ok: false, code: 'money' });
  assert.deepEqual(payloadFor('money', '150 000'), { ok: true, value: '150000' });
});

test('число: запятая и точка равны', () => {
  assert.deepEqual(parseNumber('12,5'), { ok: true, value: 12.5 });
  assert.deepEqual(parseNumber('12.5'), { ok: true, value: 12.5 });
  assert.deepEqual(parseNumber('1 000'), { ok: true, value: 1000 });
  assert.equal(parseNumber('1,2,3').ok, false);
  assert.deepEqual(payloadFor('number', '12,5'), { ok: true, value: '12.5' });
});

test('номер: 10 цифр после +7, маска «+7 7xx xxx xx xx»', () => {
  assert.deepEqual(parsePhoneInput('+7 709 123 45 67'), { ok: true, value: '77091234567' });
  assert.deepEqual(parsePhoneInput('8 709 123 45 67'), { ok: true, value: '77091234567' });
  assert.deepEqual(parsePhoneInput('709 123 45 67'), { ok: true, value: '77091234567' });
  assert.deepEqual(parsePhoneInput('+7 709 123 45'), { ok: false, code: 'phone' });
  assert.deepEqual(parsePhoneInput('+7 709 123 45 678'), { ok: false, code: 'phone' });
  assert.equal(maskPhone('7091234567'), '+7 709 123 45 67');
  assert.equal(maskPhone('+77091234567'), '+7 709 123 45 67');
  assert.equal(maskPhone('87091'), '+7 870 91');
  assert.equal(maskPhone('+7'), '+7');
  assert.equal(maskPhone('+7 7'), '+7 7');
  assert.equal(maskPhone('8'), '+7');
  assert.equal(maskPhone('87091234567'), '+7 709 123 45 67');
  assert.equal(maskPhone(''), '');
  assert.equal(maskPhone('+7709123456789999'), '+7 709 123 45 67');
});

test('blur без изменения — запроса нет; с изменением — есть; пустое и null — одно и то же', () => {
  assert.equal(shouldSaveOnBlur('text', 'Алматы', 'Алматы'), false);
  assert.equal(shouldSaveOnBlur('text', '  Алматы ', 'Алматы'), false);
  assert.equal(shouldSaveOnBlur('text', '', null), false);
  assert.equal(shouldSaveOnBlur('text', 'Астана', 'Алматы'), true);
  assert.equal(shouldSaveOnBlur('money', '150 000', 150000), false);
  assert.equal(shouldSaveOnBlur('money', '150 001', 150000), true);
  assert.equal(shouldSaveOnBlur('phone', '+7 709 123 45 67', '77091234567'), false);
  assert.equal(shouldSaveOnBlur('multiselect', ['a', 'b'], ['a', 'b']), false);
  assert.equal(shouldSaveOnBlur('multiselect', ['a'], ['a', 'b']), true);
  assert.equal(shouldSaveOnBlur('boolean', false, null), true);
  assert.deepEqual(prepareSave('text', '', 'x'), { kind: 'save', next: null });
});

test('неразбираемый черновик — ошибка на месте, а не запрос', () => {
  assert.deepEqual(prepareSave('money', '1 500,50', 1000), { kind: 'invalid', code: 'money' });
  assert.deepEqual(prepareSave('phone', '+7 709', null), { kind: 'invalid', code: 'phone' });
});

test('Esc возвращает прежнее значение в виде для ввода', () => {
  assert.equal(revertDraft('text', 'Алматы'), 'Алматы');
  assert.equal(revertDraft('money', 150000), '150 000');
  assert.equal(revertDraft('phone', '77091234567'), '+7 709 123 45 67');
  assert.equal(revertDraft('text', null), '');
  assert.deepEqual(revertDraft('multiselect', ['a']), ['a']);
  assert.equal(revertDraft('boolean', true), true);
  assert.equal(draftFor('number', 12.5), '12,5');
});

test('409 → состояние conflict с новым значением и моим черновиком', () => {
  const s = stateAfterSave('мой', { ok: false, kind: 'conflict', current: 'чужой', known: true });
  assert.deepEqual(s, { phase: 'conflict', draft: 'мой', current: 'чужой', known: true });
});

test('прочие ответы: успех, проверка поля, нет права, нет сети', () => {
  assert.deepEqual(stateAfterSave('x', { ok: true }), { phase: 'view' });
  assert.deepEqual(stateAfterSave('x', { ok: false, kind: 'fields', code: 'too_long' }), { phase: 'error', draft: 'x', reason: 'fields', code: 'too_long' });
  assert.deepEqual(stateAfterSave('x', { ok: false, kind: 'forbidden' }), { phase: 'locked', reason: 'forbidden' });
  assert.deepEqual(stateAfterSave('x', { ok: false, kind: 'readonly' }), { phase: 'locked', reason: 'readonly' });
  assert.deepEqual(stateAfterSave('x', { ok: false, kind: 'network' }), { phase: 'error', draft: 'x', reason: 'network' });
});

test('показ: деньги «150 000 ₸», дата дд.мм.гггг, список подписью, архивный виден', () => {
  const o = { yes: 'Да', no: 'Нет' };
  assert.equal(displayValue('money', 150000, o).replace(/[  ]/g, ' '), '150 000 ₸');
  assert.equal(displayValue('date', '2026-11-05', o), '05.11.2026');
  assert.equal(displayValue('select', 'old', { ...o, options: [{ key: 'old', label: 'Старый', archived: true }] }), 'Старый');
  assert.equal(displayValue('multiselect', ['a', 'b'], { ...o, options: [{ key: 'a', label: 'А' }, { key: 'b', label: 'Б' }] }), 'А, Б');
  assert.equal(displayValue('boolean', false, o), 'Нет');
  assert.equal(displayValue('text', null, o), '');
  assert.equal(displayValue('phone', '77091234567', o), '+7 709 123 45 67');
});

test('типы и мгновенное сохранение', () => {
  assert.equal(isInlineType('datetime'), false);
  assert.equal(isInlineType('user'), false);
  assert.equal(isInlineType('money'), true);
  assert.equal(commitsOnPick('select'), true);
  assert.equal(commitsOnPick('boolean'), true);
  assert.equal(commitsOnPick('date'), true);
  assert.equal(commitsOnPick('text'), false);
  assert.equal(valueFromPayload('money', '150000'), 150000);
  assert.equal(valueFromPayload('text', 'x'), 'x');
});
