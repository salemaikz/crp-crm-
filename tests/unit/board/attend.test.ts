// Тумблеры «Был на …» (pipeline-v2 §5.2) и блок явки окна № 33 (§3.4): кто может нажать, когда погашено и почему.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attendanceBlock, attendanceRequest, eventKindOf, toggleView, toggleViews } from '@/ui/board/attend';
import { card } from './fixtures';

const BEHAVIORS = { meet: 'group', consult: 'individual' } as const;
const NOW = 1_000_000;
const ev = (over: Partial<NonNullable<ReturnType<typeof card>['event']>> = {}) => ({ type: 'meet', status: 'registered', startsAt: NOW - 3_600_000, bookingId: 'bk-1', bookingVersion: 3, ...over });
const op = { canAttend: false, eventBehaviors: BEHAVIORS };
const lead = { canAttend: true, eventBehaviors: BEHAVIORS };

test('вид записи карточки определяется по поведению вида записи из настроек', () => {
  assert.equal(eventKindOf(card({ event: ev() }), BEHAVIORS), 'attendedGroup');
  assert.equal(eventKindOf(card({ event: ev({ type: 'consult' }) }), BEHAVIORS), 'attendedIndividual');
  assert.equal(eventKindOf(card({ event: ev({ type: 'неизвестный' }) }), BEHAVIORS), null);
  assert.equal(eventKindOf(card(), BEHAVIORS), null);
});

test('оператор без права: тумблер показывает признак и не нажимается (D-340)', () => {
  const c = card({ state: 'agreed', event: ev(), flags: { attendedGroup: true, attendedIndividual: false, noShow: false } });
  const v = toggleView(c, 'attendedGroup', op, NOW);
  assert.equal(v.on, true);
  assert.equal(v.interactive, false);
  assert.equal(v.hint, 'noRight');
});

test('право выдаётся только настройкой роли: тот же код делает тумблер нажимаемым', () => {
  const c = card({ state: 'agreed', event: ev() });
  assert.equal(toggleView(c, 'attendedGroup', op, NOW).interactive, false);
  assert.equal(toggleView(c, 'attendedGroup', lead, NOW).interactive, true);
});

test('с правом: до начала мероприятия, без записи этого вида и после отметки «пришёл» тумблер погашен с подсказкой', () => {
  assert.equal(toggleView(card({ event: ev({ startsAt: NOW + 1000 }) }), 'attendedGroup', lead, NOW).hint, 'notStarted');
  assert.equal(toggleView(card({ event: ev() }), 'attendedIndividual', lead, NOW).hint, 'noBooking');
  assert.equal(toggleView(card(), 'attendedGroup', lead, NOW).hint, 'noBooking');
  const done = toggleView(card({ event: ev({ status: 'attended' }) }), 'attendedGroup', lead, NOW);
  assert.deepEqual([done.on, done.interactive, done.hint], [true, false, 'done']);
  assert.equal(toggleView(card({ event: ev({ status: 'cancelled' }) }), 'attendedGroup', lead, NOW).interactive, false);
});

test('неявку можно исправить на «пришёл» (автомат статусов), поэтому тумблер доступен', () => {
  assert.equal(toggleView(card({ event: ev({ status: 'no_show' }) }), 'attendedGroup', lead, NOW).interactive, true);
});

test('плитка показывает только значимые тумблеры; шторка - оба', () => {
  assert.equal(toggleViews(card(), lead, NOW).length, 0);
  assert.deepEqual(toggleViews(card({ event: ev() }), lead, NOW).map((v) => v.kind), ['attendedGroup']);
  assert.deepEqual(toggleViews(card({ flags: { attendedGroup: false, attendedIndividual: true, noShow: false } }), op, NOW).map((v) => v.kind), ['attendedIndividual']);
  assert.deepEqual(toggleViews(card(), lead, NOW, true).map((v) => v.kind), ['attendedGroup', 'attendedIndividual']);
});

test('запрос отметки явки: запись карточки, версия записи, статус «пришёл»', () => {
  const r = attendanceRequest(card({ event: ev() }), 'attended', 'op-1');
  assert.deepEqual(r, { url: '/api/bookings/bk-1/attendance', body: { opId: 'op-1', version: 3, to: 'attended' } });
  assert.equal(attendanceRequest(card(), 'attended', 'op-1'), null);
});

test('окно № 33: переключатель - при праве и начавшемся мероприятии, иначе статус только для чтения', () => {
  assert.equal(attendanceBlock(card({ event: ev() }), true, NOW).mode, 'switch');
  const early = attendanceBlock(card({ event: ev({ startsAt: NOW + 5 }) }), true, NOW);
  assert.deepEqual([early.mode, early.hint], ['readonly', 'notStarted']);
  const noRight = attendanceBlock(card({ event: ev({ status: 'no_show' }) }), false, NOW);
  assert.deepEqual([noRight.mode, noRight.status, noRight.hint], ['readonly', 'no_show', 'noRight']);
  assert.equal(attendanceBlock(card({ event: ev({ status: 'confirmed' }) }), false, NOW).status, 'unmarked');
  assert.equal(attendanceBlock(card(), true, NOW).mode, 'hidden');
});

test('окно № 33: уже отмеченная явка - только статус, переключателя нет (иначе сервер ответит 409 attendance_changed)', () => {
  const attended = attendanceBlock(card({ event: ev({ status: 'attended' }) }), true, NOW);
  assert.deepEqual([attended.mode, attended.status, attended.hint, attended.bookingId], ['readonly', 'attended', null, 'bk-1']);
  const noShow = attendanceBlock(card({ event: ev({ status: 'no_show' }) }), true, NOW);
  assert.deepEqual([noShow.mode, noShow.status], ['readonly', 'no_show']);
});
