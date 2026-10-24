// Обзвон «подтвердить явку» на доске: строка шапки, запросы трёх ответов, офлайн, ошибки, opId (D-355).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpIds, confirmColumnKey, confirmEventsFor, declineRequest, dayMonth, errorKeyOf, eventsText, needsAnswer, offlineDisabled, remainingOf, settles, yesRequest, type ConfirmInfo } from '@/ui/board/confirm';
import { planFor } from '@/ui/board/moves';
import { CONFIG, card } from './fixtures';

const INFO: ConfirmInfo = { day: '2026-10-22', events: [{ type: 'meet', date: '2026-10-24' }], declineReason: 'wont_come', summary: { todo: 3, tried: 2, confirmed: 8 } };
const booking = { type: 'meet', status: 'registered', startsAt: 1, bookingId: 'bk-1', bookingVersion: 7 };

test('осталось ответить: «не звонили» и «не дозвонились»; «придёт» не считается', () => {
  assert.equal(remainingOf(INFO.summary), 5);
});

test('дата мероприятия: «дд.мм» без часовых поясов; не дата остаётся как есть', () => {
  assert.equal(dayMonth('2026-10-24'), '24.10');
  assert.equal(dayMonth('завтра'), 'завтра');
});

test('строка событий: короткие подписи из настроек; неизвестный вид — запасная подпись, не ключ', () => {
  assert.equal(eventsText(INFO.events, { meet: 'Встреча' }, 'Запись'), 'Встреча 24.10');
  assert.equal(eventsText(INFO.events, {}, 'Запись'), 'Запись 24.10');
  assert.equal(eventsText([...INFO.events, { type: 'x', date: '2026-10-25' }], { meet: 'A', x: 'B' }, '?'), 'A 24.10; B 25.10');
});

test('мероприятия колонки: по видам колонки; у колонки без видов — все', () => {
  assert.equal(confirmEventsFor(INFO, ['meet']).length, 1);
  assert.equal(confirmEventsFor(INFO, ['other']).length, 0);
  assert.equal(confirmEventsFor(INFO, []).length, 1);
});

test('вкладка записи для фильтра: колонка «Договорились» с видом из обзвона, иначе первая «Договорились»', () => {
  const cols = [
    { key: 'new', role: 'new' as const, eventTypes: [] },
    { key: 'a', role: 'agreed' as const, eventTypes: ['other'] },
    { key: 'b', role: 'agreed' as const, eventTypes: ['meet'] },
  ];
  assert.equal(confirmColumnKey(cols, INFO), 'b');
  assert.equal(confirmColumnKey(cols.slice(0, 2), INFO), null);
  assert.equal(confirmColumnKey([{ key: 'a', role: 'agreed' as const, eventTypes: [] }], INFO), 'a');
});

test('плитке нужен ответ, пока она не «придёт»; без пометки обзвона ответа нет', () => {
  assert.equal(needsAnswer(card()), false);
  assert.equal(needsAnswer(card({ confirm: { mark: 'todo', tries: 0, lastTryAt: null, confirmedAt: null } })), true);
  assert.equal(needsAnswer(card({ confirm: { mark: 'tried', tries: 1, lastTryAt: 5, confirmedAt: null } })), true);
  assert.equal(needsAnswer(card({ confirm: { mark: 'confirmed', tries: 0, lastTryAt: null, confirmedAt: 9 } })), false);
});

test('«Придёт»: подтверждение записи с версией записи с плитки и opId; нет записи — запроса нет', () => {
  const c = card({ state: 'agreed', event: booking });
  assert.deepEqual(yesRequest(c, 'op-1'), { url: '/api/bookings/bk-1/confirm', body: { opId: 'op-1', version: 7, to: 'confirmed' } });
  assert.equal(yesRequest(card({ event: null }), 'op-1'), null);
});

test('«Не придёт»: выход в «Перезвон» с причиной из настроек и сроком «в течение дня», версия карточки', () => {
  const c = card({ id: 'card-1', version: 4 });
  assert.deepEqual(declineRequest(c, 'wont_come', 1_700_000_000_000, 'op-2'), {
    url: '/api/cards/card-1/move',
    body: { opId: 'op-2', version: 4, to: 'callback', reasonCode: 'wont_come', callbackAt: 1_700_000_000_000, callbackPrecision: 'day' },
  });
});

test('без сети «Придёт» и «Не придёт» погашены, «Не дозвонился» нет', () => {
  assert.deepEqual(offlineDisabled(false), { yes: true, decline: true, noAnswer: false });
  assert.deepEqual(offlineDisabled(true), { yes: false, decline: false, noAnswer: false });
});

test('ошибки сервера → тексты: 409, too_late, reason_not_applicable, 404, 423, прочее', () => {
  assert.equal(errorKeyOf(409, null), 'changed');
  assert.equal(errorKeyOf(400, 'too_late'), 'tooLate');
  assert.equal(errorKeyOf(400, 'reason_not_applicable'), 'notApplicable');
  assert.equal(errorKeyOf(404, null), 'unavailable');
  assert.equal(errorKeyOf(423, null), 'readOnly');
  assert.equal(errorKeyOf(500, null), 'failed');
  assert.equal(errorKeyOf(400, 'other'), 'failed');
});

test('ответ получен (не 5xx) — действие закончено; сетевая ошибка и 5xx — повтор с тем же opId', () => {
  assert.equal(settles(200), true);
  assert.equal(settles(409), true);
  assert.equal(settles(503), false);
  assert.equal(settles(0), false);
});

test('opId одного действия повторяется до окончания и меняется после него; разные действия — разные opId', () => {
  let n = 0;
  const ids = new OpIds(() => `op-${++n}`);
  const a = ids.get('c1', 'yes');
  assert.equal(ids.get('c1', 'yes'), a);
  assert.notEqual(ids.get('c1', 'decline'), a);
  assert.notEqual(ids.get('c2', 'yes'), a);
  ids.done('c1', 'yes');
  assert.notEqual(ids.get('c1', 'yes'), a);
});

test('«Не дозвонился» на «Договорились» не переносит плитку: итог ложится фактом, карточка остаётся', () => {
  const agreed = card({ state: 'agreed', event: booking });
  assert.equal(planFor(agreed, { kind: 'no_answer' }, { reasonCode: '', callbackAt: null, callbackPrecision: undefined }, CONFIG.columns, 0), null);
  const fresh = card({ state: 'new' });
  assert.notEqual(planFor(fresh, { kind: 'no_answer' }, { reasonCode: '', callbackAt: null, callbackPrecision: undefined }, CONFIG.columns, 0), null);
});
