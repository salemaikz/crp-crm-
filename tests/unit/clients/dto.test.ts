// Сборка DTO: главный номер, ЛПР, номер в каноне, шапка карточки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickDecisionMaker, pickPrimaryPhone, toCardHead, toPhoneDto } from '../../../src/server/domain/clients/dto';
import type { CardHeadDb, PhoneRowDb } from '../../../src/server/domain/clients/repo';
import type { ContactDto } from '../../../src/server/domain/clients/types';

const phone = (id: string, o: Partial<PhoneRowDb> = {}): PhoneRowDb => ({
  id,
  digits: '77095550101',
  ext: '',
  kind: 'mobile',
  isWorking: true,
  isPrimary: false,
  hasWhatsapp: 'unknown',
  contactId: null,
  createdAt: 1,
  ...o,
});

test('номер: e164 из канона, добавочный и признаки', () => {
  const d = toPhoneDto(phone('p1', { ext: '12', isPrimary: true, contactId: 'c1' }));
  assert.deepEqual(d, { id: 'p1', e164: '+77095550101', ext: '12', kind: 'mobile', working: true, primary: true, contactId: 'c1', hasWhatsapp: 'unknown' });
});

test('главный номер: рабочий основной, иначе первый рабочий, иначе нет', () => {
  const a = toPhoneDto(phone('a', { isWorking: false, isPrimary: false }));
  const b = toPhoneDto(phone('b', { digits: '77095550102' }));
  const c = toPhoneDto(phone('c', { digits: '77095550103', isPrimary: true }));
  assert.equal(pickPrimaryPhone([a, b, c])?.id, 'c');
  assert.equal(pickPrimaryPhone([a, b])?.id, 'b');
  assert.equal(pickPrimaryPhone([a]), null);
  assert.equal(pickPrimaryPhone([]), null);
  // основной, но нерабочий, главным не считается
  assert.equal(pickPrimaryPhone([toPhoneDto(phone('x', { isWorking: false, isPrimary: true })), b])?.id, 'b');
});

test('ЛПР: первый контакт с признаком', () => {
  const mk = (id: string, dm: boolean): ContactDto => ({
    id,
    name: `Имя ${id}`,
    position: '',
    isDecisionMaker: dm,
    callHint: '',
    note: '',
    fields: { fields: [], values: {} },
  });
  assert.deepEqual(pickDecisionMaker([mk('1', false), mk('2', true), mk('3', true)]), { contactId: '2', name: 'Имя 2' });
  assert.equal(pickDecisionMaker([mk('1', false)]), null);
});

test('шапка карточки: счётчики с карточки, lpr и цель только из закрытого списка', () => {
  const row: CardHeadDb = {
    id: 'cd',
    state: 'retry',
    holdReason: '',
    nextCallAt: 5,
    attempts: 2,
    lpr: 'maybe',
    isTarget: 'yes',
    lastOutcomeCode: 'no_answer',
    callsTotal: 4,
    noAnswerTotal: 3,
    connectsTotal: 1,
    firstConnectAt: 10,
    lastConnectAt: 20,
    lastTouchAt: 30,
    ownerName: 'Оператор',
    actingName: null,
    version: 7,
    ownerUserId: 'u1',
    actingUntilDay: null,
    closeReasonCode: '',
    closedAt: null,
    returnAt: null,
    custom: {},
    canBook: false,
    canEditCard: false,
  };
  const h = toCardHead(row, { fields: [], values: {} });
  assert.equal(h.version, 7);
  assert.equal(h.ownerUserId, 'u1');
  assert.equal(h.lpr, '');
  assert.equal(h.isTarget, 'yes');
  assert.deepEqual(h.counters, { callsTotal: 4, noAnswerTotal: 3, connectsTotal: 1, firstConnectAt: 10, lastConnectAt: 20, lastTouchAt: 30 });
});
