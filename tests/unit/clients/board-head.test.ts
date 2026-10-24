// Шапка карточки от доски (C4): колонка по ядру, тон по board.tones, явка, причина перезвона; покупки — только с deal.read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCardBoard, type BoardHeadSettings } from '../../../src/server/domain/clients/boardHead';
import { parseBoardSettings } from '../../../src/server/domain/cards/boardSettings';
import { pickNextStep } from '../../../src/server/domain/timeline/summary';

const t = (ru: string) => ({ ru });
const board = parseBoardSettings({
  board: {
    columns: [
      { key: 'fresh', label: t('Новые'), states: ['new'] },
      { key: 'again', label: t('Перезвон'), states: ['retry', 'callback'] },
      { key: 'review', label: t('Разбор'), states: ['agreed'], eventTypes: ['consult'] },
      { key: 'group', label: t('Встреча'), states: ['agreed'] },
      { key: 'buyers', label: t('Клиенты'), states: ['client'] },
    ],
    agreedFallback: 'group',
    tones: [
      { when: 'attendedIndividual', tone: 'warning' },
      { when: 'attendedGroup', tone: 'success' },
      { when: 'purchased', tone: 'info' },
      { when: 'noShow', tone: 'danger' },
      { when: 'unknownRule', tone: 'danger' },
      { when: 'noShow', tone: 'rainbow' },
    ],
  },
});
const settings: BoardHeadSettings = { board, callbackReasons: { thinking: 'Подумает' }, attendLabels: { group: 'Встреча', individual: 'Разбор' } };

const row = {
  state: 'callback',
  holdReason: '',
  ownerUserId: 'u1',
  attempts: 0,
  closedAt: null,
  bookingType: null as string | null,
  bookingStatus: null as string | null,
  callbackReason: 'thinking',
  callbackTouches: 2,
  attendedGroupAt: null as number | null,
  attendedIndividualAt: null as number | null,
  lastNoShowAt: null as number | null,
  purchasesTotal: 0,
  nextCallPrecision: 'day' as const,
};

test('колонка и подпись причины: перезвон — колонка «Перезвон», причина с касанием', () => {
  const b = toCardBoard(row, settings, false);
  assert.equal(b.column, 'again');
  assert.equal(b.columnLabel, 'Перезвон');
  assert.equal(b.callbackReason, 'thinking');
  assert.equal(b.callbackReasonLabel, 'Подумает');
  assert.equal(b.callbackTouches, 2);
  assert.equal(b.tone, null);
});

test('код причины не из справочника: подписи нет, сырой ключ не показывается', () => {
  assert.equal(toCardBoard({ ...row, callbackReason: 'legacy_x' }, settings, false).callbackReasonLabel, null);
  assert.equal(toCardBoard({ ...row, callbackReason: '' }, settings, false).callbackReasonLabel, null);
  assert.equal(toCardBoard({ ...row, callbackReason: 'constructor' }, settings, false).callbackReasonLabel, null);
});

test('«Договорились»: колонка по виду записи открытой сделки, иначе запасная', () => {
  const agreed = { ...row, state: 'agreed' };
  assert.equal(toCardBoard({ ...agreed, bookingType: 'consult', bookingStatus: 'registered' }, settings, false).column, 'review');
  assert.equal(toCardBoard(agreed, settings, false).column, 'group');
});

test('явка: подписи вида, тон по первому совпавшему правилу; неизвестные правило и тон пропускаются', () => {
  const g = toCardBoard({ ...row, attendedGroupAt: 100 }, settings, false);
  assert.deepEqual(g.attended, { group: 'Встреча', individual: null });
  assert.equal(g.tone, 'success');
  const both = toCardBoard({ ...row, attendedGroupAt: 100, attendedIndividualAt: 200 }, settings, false);
  assert.equal(both.tone, 'warning');
  assert.deepEqual(both.attended, { group: 'Встреча', individual: 'Разбор' });
});

test('неявка считается только позже последней явки; тон «danger» по правилу noShow', () => {
  assert.equal(toCardBoard({ ...row, lastNoShowAt: 300, attendedGroupAt: 200 }, settings, false).noShow, true);
  const after = toCardBoard({ ...row, lastNoShowAt: 100, attendedGroupAt: 200 }, settings, false);
  assert.equal(after.noShow, false);
  assert.equal(toCardBoard({ ...row, lastNoShowAt: 300 }, settings, false).tone, 'danger');
});

test('покупки: без deal.read признак и тон не раскрываются', () => {
  const r = { ...row, state: 'client', purchasesTotal: 2 };
  assert.deepEqual([toCardBoard(r, settings, true).purchased, toCardBoard(r, settings, true).tone], [true, 'info']);
  assert.deepEqual([toCardBoard(r, settings, false).purchased, toCardBoard(r, settings, false).tone], [false, null]);
});

test('карточка не на доске (задержана): колонки нет, подписи нет', () => {
  const b = toCardBoard({ ...row, holdReason: 'merged' }, settings, false);
  assert.equal(b.column, null);
  assert.equal(b.columnLabel, null);
});

test('следующий шаг: точность «day» попадает в ответ, «time» — нет (прежний вид)', () => {
  const base = { state: 'callback', nextCallAt: 10, nextBookingAt: null, task: null };
  assert.deepEqual(pickNextStep({ ...base, nextCallPrecision: 'day' }), { kind: 'callback', at: 10, precision: 'day' });
  assert.deepEqual(pickNextStep({ ...base, nextCallPrecision: 'time' }), { kind: 'callback', at: 10 });
  assert.deepEqual(pickNextStep({ ...base, state: 'client', task: { source: 'manual', dueAt: 5, duePrecision: 'day' } }), { kind: 'task', at: 5, taskSource: 'manual', precision: 'day' });
});
