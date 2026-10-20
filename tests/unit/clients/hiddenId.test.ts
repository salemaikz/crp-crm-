// Правило скрытого номера клиента в правке (D-192): записать, сбросить или не трогать iin_hmac.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hiddenIdAction, type HiddenIdInput } from '../../../src/server/domain/clients/hiddenId';

const FORMS = [
  { key: 'too', idIsPersonal: false },
  { key: 'ip', idIsPersonal: true },
];
const at = (over: Partial<HiddenIdInput> & { patch: HiddenIdInput['patch'] }): HiddenIdInput => ({
  hiddenId: null,
  current: { legalForm: 'ip', hasHiddenId: true },
  clientKind: 'company',
  legalForms: FORMS,
  ...over,
});

test('новый ИИН — записать HMAC', () => {
  assert.deepEqual(hiddenIdAction(at({ patch: { org_id: '880101300001' }, hiddenId: 'h1' })), { kind: 'set', hmac: 'h1' });
});

test('очистка номера сбрасывает HMAC при личной и неопределённой форме', () => {
  assert.deepEqual(hiddenIdAction(at({ patch: { org_id: null } })), { kind: 'clear' });
  assert.deepEqual(hiddenIdAction(at({ patch: { org_id: '  ' }, current: { legalForm: '', hasHiddenId: true } })), { kind: 'clear' });
});

test('смена формы на «не личную» сбрасывает HMAC; на неопределённую — нет; у физлица — нет', () => {
  assert.deepEqual(hiddenIdAction(at({ patch: { legal_form: 'too' } })), { kind: 'clear' });
  assert.deepEqual(hiddenIdAction(at({ patch: { legal_form: '' } })), { kind: 'keep' });
  assert.deepEqual(hiddenIdAction(at({ patch: { legal_form: 'too' }, clientKind: 'person' })), { kind: 'keep' });
});

test('правка без формы и номера и клиент без скрытого номера — не трогать', () => {
  assert.deepEqual(hiddenIdAction(at({ patch: { region: 'Павлодар' } })), { kind: 'keep' });
  assert.deepEqual(hiddenIdAction(at({ patch: { org_id: null }, current: { legalForm: 'ip', hasHiddenId: false } })), { kind: 'keep' });
});
