// Окно № 33 (pipeline-v2 §3.3–§3.4): подстановка причины и срока по явке, тело запроса, разбор ответа, цели «Мусора».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoDue, autoReason, exitBody, exitCallConfig, exitOutcome, exitToOf, exitTrashChoices, planExit } from '@/ui/board/exit';
import { CALL, COLUMNS, CONFIG, card } from './fixtures';

const agreed = card({ state: 'agreed', column: 'meet', callbackTouches: 1, version: 7, event: { type: 'meet', status: 'registered', startsAt: 1, bookingId: 'bk-1', bookingVersion: 2 } });
const cfg = CONFIG.agreedExit;
const reasons = [{ key: 'think' }, { key: 'no_show_meet' }, { key: 'attended_no_buy' }];
// 2026-10-23 (пт) 12:00 по Алматы
const NOW = Date.UTC(2026, 9, 23, 7, 0);

test('причина по явке: «не пришёл» - причина неявки вида записи, «пришёл» - «не купил», «не отмечать» - пусто', () => {
  assert.equal(autoReason('no_show', agreed, cfg, reasons), 'no_show_meet');
  assert.equal(autoReason('attended', agreed, cfg, reasons), 'attended_no_buy');
  assert.equal(autoReason('none', agreed, cfg, reasons), '');
});

test('причина подставляется, только если она есть среди предложенных ручных причин', () => {
  assert.equal(autoReason('no_show', agreed, cfg, [{ key: 'think' }]), '');
  assert.equal(autoReason('no_show', agreed, { ...cfg, noShowReasons: {} }, reasons), '');
  assert.equal(autoReason('attended', agreed, { ...cfg, attendedReason: null }, reasons), '');
});

test('срок: после неявки - шаг настроек (следующий рабочий день, время), иначе по касанию, без графика - нет', () => {
  const noShow = autoDue('no_show', agreed, cfg, CALL, NOW);
  assert.ok(noShow);
  assert.equal(noShow.precision, 'time');
  // Следующий рабочий день после пятницы - понедельник 26.10, 10:00 по Алматы (UTC+5)
  assert.equal(noShow.at, Date.UTC(2026, 9, 26, 5, 0));
  assert.equal(autoDue('none', agreed, cfg, CALL, NOW), null);
  const byTouch = autoDue('attended', agreed, cfg, { ...CALL, callbackSchedule: ['+3d', '+7d@10:00'] }, NOW);
  assert.ok(byTouch);
  // Касание 2 (один перезвон уже был): шаг «+7d@10:00»
  assert.equal(byTouch.precision, 'time');
});

test('тело запроса № 33: строгая схема, без лишних ключей; срок и явка только у перезвона', () => {
  const due = { at: 5000, precision: 'day' as const };
  const att = { bookingId: 'bk-1', to: 'no_show' as const };
  assert.deepEqual(exitBody({ opId: 'o1', card: agreed, to: 'callback', reasonCode: 'no_show_meet', reasonText: ' заметка ', due, attendance: att }), {
    opId: 'o1',
    version: 7,
    to: 'callback',
    reasonCode: 'no_show_meet',
    reasonText: 'заметка',
    callbackAt: 5000,
    callbackPrecision: 'day',
    attendance: att,
  });
  assert.deepEqual(exitBody({ opId: 'o2', card: agreed, to: 'written_off', reasonCode: 'unreachable', reasonText: '', due, attendance: att }), { opId: 'o2', version: 7, to: 'written_off', reasonCode: 'unreachable' });
});

test('ответы сервера: 404, 409, 423, 403, 400 разбираются по §3.4', () => {
  assert.equal(exitOutcome(200), 'ok');
  assert.equal(exitOutcome(404), 'gone');
  assert.equal(exitOutcome(409), 'changed');
  assert.equal(exitOutcome(423), 'readOnly');
  assert.equal(exitOutcome(403), 'forbidden');
  assert.equal(exitOutcome(400), 'invalid');
  assert.equal(exitOutcome(500), 'failed');
});

test('раскладка «в уме»: перезвон - в колонку «Перезвон» без записи, закрытие - в «Мусор»', () => {
  const due = { at: 9000, precision: 'time' as const };
  const cb = planExit(agreed, 'callback', 'think', due, COLUMNS, NOW);
  assert.equal(cb?.column, 'callback');
  assert.equal(cb?.patch.state, 'callback');
  assert.equal(cb?.patch.callbackTouches, 2);
  assert.equal(cb?.patch.event, null);
  assert.equal(planExit(agreed, 'callback', 'think', null, COLUMNS, NOW), null);
  const tr = planExit(agreed, 'not_interested', 'no_need', null, COLUMNS, NOW);
  assert.equal(tr?.column, 'trash');
  assert.equal(tr?.patch.state, 'not_interested');
});

test('«Мусор» из «Договорились»: только «Не интересует» и списание, без блокировки «сначала позвоните»', () => {
  const trash = COLUMNS.find((c) => c.key === 'trash')!;
  const { quick, more } = exitTrashChoices(trash, CALL, CONFIG.writeOffReasons);
  assert.deepEqual(quick.map((c) => `${c.kind}:${c.reason}`), ['outcome:no_need', 'write_off:unreachable']);
  assert.ok(quick.every((c) => c.kind !== 'write_off' || c.blocked === null));
  // «Не целевой» - из меню карточки, здесь его нет; «Другое» со списанием требует текста и не предлагается
  assert.ok(more.every((c) => !(c.kind === 'outcome' && c.outcomeKind === 'not_target')));
  assert.deepEqual(more.map((c) => `${c.kind}:${c.reason}`).sort(), ['outcome:later', 'outcome:other']);
  assert.equal(exitToOf(quick[0]!), 'not_interested');
  assert.equal(exitToOf(quick[1]!), 'written_off');
});

test('настройки листа причин: ЛПР, контакт и поля итога не требуются', () => {
  const c = exitCallConfig({ ...CALL, outcomes: CALL.outcomes.map((o) => ({ ...o, requires: { ...o.requires, lpr: true, fields: ['x'] } })) });
  assert.equal(c.lprRequiredOnContact, false);
  assert.ok(c.outcomes.every((o) => !o.requires.lpr && o.requires.fields.length === 0));
});
