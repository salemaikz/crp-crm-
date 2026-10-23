// Проверка шторки на устройстве и сборка тела итога (зеркало правил ядра).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, lprNeeded, missingFor, oneTap } from '../../../src/ui/call/validate';
import { EMPTY_DRAFT, type CallConfig, type OutcomeButton, type SheetDraft } from '../../../src/ui/call/types';

const def = (kind: OutcomeButton['kind'], over: Partial<OutcomeButton['requires']> = {}, reasons: OutcomeButton['reasons'] = []): OutcomeButton => ({
  key: kind,
  kind,
  label: kind,
  color: '#336699',
  requires: { lpr: false, reason: false, callbackAt: false, contact: false, agreement: false, fields: [], ...over },
  reasons,
});

const CONFIG: CallConfig = {
  userId: 'u1',
  outcomes: [],
  undoMs: 5000,
  lprNoRequiresInfo: true,
  lprRequiredOnContact: true,
  outcomeFields: {},
  callbackPresets: [],
  callsPerHourTarget: null,
  timeZone: 'Asia/Almaty',
  calendar: { workdays: [1, 2, 3, 4, 5], holidays: [] },
  callbackV2: false,
  callbackSchedule: null,
  callWindowStart: '09:00',
  cardFields: [],
};
const draft = (over: Partial<SheetDraft> = {}): SheetDraft => ({ ...EMPTY_DRAFT, ...over });

test('«Не берёт» — одно нажатие, ничего не требует', () => {
  const d = def('no_answer');
  assert.deepEqual(missingFor(d, draft(), CONFIG), []);
  assert.equal(oneTap(d, draft(), CONFIG), true);
});

test('ЛПР обязателен на дозвоне по настройке и по самому итогу', () => {
  assert.equal(lprNeeded(def('callback'), CONFIG), true);
  assert.equal(lprNeeded(def('not_target'), CONFIG), false);
  assert.equal(lprNeeded(def('not_target', { lpr: true }), CONFIG), true);
  assert.equal(lprNeeded(def('callback'), { lprRequiredOnContact: false }), false);
});

test('«Перезвонить»: нужны ЛПР и срок; «ЛПР: нет» требует данных или заметки', () => {
  const d = def('callback', { callbackAt: true });
  assert.deepEqual(missingFor(d, draft(), CONFIG), ['lpr', 'callbackAt']);
  assert.deepEqual(missingFor(d, draft({ lpr: 'yes', callbackAt: 1 }), CONFIG), []);
  assert.deepEqual(missingFor(d, draft({ lpr: 'no', callbackAt: 1 }), CONFIG), ['lprInfo']);
  assert.deepEqual(missingFor(d, draft({ lpr: 'no', callbackAt: 1, lprName: 'Иван' }), CONFIG), []);
  assert.deepEqual(missingFor(d, draft({ lpr: 'no', callbackAt: 1, note: 'ЛПР в отпуске' }), CONFIG), []);
  assert.equal(oneTap(d, draft({ lpr: 'yes', callbackAt: 1 }), CONFIG), false, 'перезвон всегда открывает срок');
});

test('причина: без выбора — нужна; «Другое» требует пояснения в заметке', () => {
  const d = def('not_interested', { reason: true, lpr: true }, [
    { key: 'no_need', label: 'Нет потребности', needsText: false },
    { key: 'other', label: 'Другое', needsText: true },
  ]);
  assert.deepEqual(missingFor(d, draft({ lpr: 'yes' }), CONFIG), ['reason']);
  assert.deepEqual(missingFor(d, draft({ lpr: 'yes', reasonCode: 'no_need' }), CONFIG), []);
  assert.deepEqual(missingFor(d, draft({ lpr: 'yes', reasonCode: 'other' }), CONFIG), ['reasonText']);
  assert.deepEqual(missingFor(d, draft({ lpr: 'yes', reasonCode: 'other', note: 'закрылись' }), CONFIG), []);
});

test('«Номер не работает» и «Полный отказ» требуют номер и никогда не ставятся одним нажатием', () => {
  for (const k of ['bad_number', 'do_not_call'] as const) {
    assert.deepEqual(missingFor(def(k), draft(), CONFIG), ['phone']);
    assert.deepEqual(missingFor(def(k), draft({ phoneId: 'p1' }), CONFIG), []);
    assert.equal(oneTap(def(k), draft({ phoneId: 'p1' }), CONFIG), false);
  }
});

test('«Договорились» ведёт в мастер записи, а не в одно нажатие; обязательные поля итога проверяются', () => {
  assert.equal(oneTap(def('agreed'), draft({ lpr: 'yes' }), CONFIG), false);
  assert.deepEqual(missingFor(def('not_target', { fields: ['niche'] }), draft(), CONFIG, { niche: '' }), ['field']);
  assert.deepEqual(missingFor(def('not_target', { fields: ['niche'] }), draft(), CONFIG, { niche: 'trade' }), []);
});

test('buildRequest: opId и время с устройства, офлайн-канал, лишнее не отправляется', () => {
  const req = buildRequest({
    opId: '00000000-0000-4000-8000-000000000001',
    cardId: 'cd-a-1',
    def: def('callback', { callbackAt: true }),
    draft: draft({ lpr: 'no', lprName: ' Иван ', callbackAt: 1_793_000_000_000, note: ' перезвонить ', target: true, phoneId: 'ph-1', alsoDncPhoneIds: ['ph-2'] }),
    tappedAt: 1_792_999_000_000,
    now: 1_793_000_000_001,
    online: false,
  });
  assert.equal(req.opId, '00000000-0000-4000-8000-000000000001');
  assert.equal(req.via, 'offline');
  assert.equal(req.occurredAt, 1_793_000_000_001);
  assert.equal(req.tappedAt, 1_792_999_000_000);
  assert.deepEqual(req.lprInfo, { name: 'Иван', phone: '', when: '' });
  assert.equal(req.note, 'перезвонить');
  assert.equal(req.markTarget, true);
  assert.deepEqual(req.alsoDncPhoneIds, [], 'отметки «тоже не звонить» только у полного отказа');
  assert.equal(req.agreement, null);
  const dnc = buildRequest({ opId: 'x', cardId: 'c', def: def('do_not_call'), draft: draft({ phoneId: 'ph-1', alsoDncPhoneIds: ['ph-1', 'ph-2'] }), tappedAt: null, now: 1, online: true });
  assert.deepEqual(dnc.alsoDncPhoneIds, ['ph-2'], 'номер разговора не дублируется');
  assert.equal(dnc.via, 'ui');
  assert.equal(dnc.callbackAt, null);
});

test('«Договорились» с обязательным контактом: без ЛПР-контакта у клиента итог не сохранить', () => {
  const d = def('agreed', { contact: true, agreement: true, lpr: true });
  assert.deepEqual(missingFor(d, draft({ lpr: 'yes' }), CONFIG, {}, false), ['contact']);
  assert.deepEqual(missingFor(d, draft({ lpr: 'yes' }), CONFIG, {}, true), []);
  // итог, которому контакт не нужен, контакта не требует
  assert.deepEqual(missingFor(def('agreed'), draft({ lpr: 'yes' }), CONFIG, {}, false), []);
});

test('тело итога несёт договорённость (запись или «позже»), по умолчанию её нет', () => {
  const base = { opId: 'o', cardId: 'c', def: def('agreed'), draft: draft({ lpr: 'yes' }), tappedAt: 1, now: 2, online: true };
  assert.equal(buildRequest(base).agreement, null);
  const agreement = { contactId: 'ct', agreedDueAt: 5, booking: null };
  assert.deepEqual(buildRequest({ ...base, agreement }).agreement, agreement);
});
