// Срок перезвона воронки v2 на устройстве: подсказка по касанию, быстрые даты, сборка запроса с callbackPrecision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dueFor, parseScheduleStep, quickDay, scheduleHint } from '../../../src/ui/call/callbackPlan';
import { manualCallbackReasons } from '../../../src/app/(op)/call/callbackReasons';
import { buildRequest } from '../../../src/ui/call/validate';
import { EMPTY_DRAFT, type CallCalendar, type CallConfig, type OutcomeButton, type SheetDraft } from '../../../src/ui/call/types';
import { fromLocal } from '../../../src/ui/call/zoned';

const TZ = 'Asia/Almaty';
const CAL: CallCalendar = { workdays: [1, 2, 3, 4, 5], holidays: [] };
// 2026-10-26 — понедельник, 11:00 местного
const MON = fromLocal('2026-10-26', '11:00', TZ);
const FRI = fromLocal('2026-10-30', '11:00', TZ);
const STEPS = ['+3d', '+7d', '+14d'];

test('manual: системные и архивные причины в шторку не попадают', () => {
  const r = (key: string, extra: Record<string, unknown> = {}) => ({ key, label: { ru: key }, needsText: false, ...extra });
  const out = manualCallbackReasons([r('think'), r('repeat_sale', { manual: false }), r('old', { archived: true }), r('not_now', { manual: true }), r('x', { manual: undefined })]);
  assert.deepEqual(out.map((x) => x.key), ['think', 'not_now', 'x']);
});

test('шаг: +Nd и +Nd@HH:MM, мусор отклоняется', () => {
  assert.deepEqual(parseScheduleStep('+3d'), { days: 3, time: null });
  assert.deepEqual(parseScheduleStep('+7d@10:30'), { days: 7, time: '10:30' });
  for (const bad of ['3d', '+0d', '+366d', '+3d@24:00', '+3h', '']) assert.equal(parseScheduleStep(bad), null, bad);
});

test('подсказка: первое касание — +3 дня, второе — +7, четвёртое повторяет последний шаг', () => {
  const h1 = scheduleHint({ steps: STEPS, touches: 0, now: MON, tz: TZ, cal: CAL });
  assert.deepEqual(h1, { touch: 1, days: 3, day: '2026-10-29', precision: 'day', time: null });
  assert.equal(scheduleHint({ steps: STEPS, touches: 1, now: MON, tz: TZ, cal: CAL })?.day, '2026-11-02');
  const h4 = scheduleHint({ steps: STEPS, touches: 3, now: MON, tz: TZ, cal: CAL });
  assert.equal(h4?.touch, 4);
  assert.equal(h4?.days, 14);
});

test('подсказка: нерабочий день сдвигается на ближайший рабочий; шаг со временем даёт точность time', () => {
  // пятница + 3 дня = понедельник; +1 из пятницы = суббота → понедельник
  assert.equal(scheduleHint({ steps: ['+1d'], touches: 0, now: FRI, tz: TZ, cal: CAL })?.day, '2026-11-02');
  const withTime = scheduleHint({ steps: ['+2d@14:00'], touches: 0, now: MON, tz: TZ, cal: CAL });
  assert.deepEqual(withTime && { precision: withTime.precision, time: withTime.time }, { precision: 'time', time: '14:00' });
});

test('подсказки нет без шагов и при неверном шаге', () => {
  assert.equal(scheduleHint({ steps: [], touches: 0, now: MON, tz: TZ, cal: CAL }), null);
  assert.equal(scheduleHint({ steps: ['скоро'], touches: 0, now: MON, tz: TZ, cal: CAL }), null);
});

test('«Завтра» и «Через неделю» — рабочие дни', () => {
  assert.equal(quickDay('tomorrow', MON, TZ, CAL), '2026-10-27');
  assert.equal(quickDay('tomorrow', FRI, TZ, CAL), '2026-11-02');
  assert.equal(quickDay('week', MON, TZ, CAL), '2026-11-02');
  assert.equal(quickDay('week', FRI, TZ, CAL), '2026-11-06');
});

test('срок без времени — начало окна звонков и «день»; со временем — «время»', () => {
  assert.deepEqual(dueFor('2026-10-29', null, '09:00', TZ), { at: fromLocal('2026-10-29', '09:00', TZ), precision: 'day' });
  assert.deepEqual(dueFor('2026-10-29', '15:30', '09:00', TZ), { at: fromLocal('2026-10-29', '15:30', TZ), precision: 'time' });
});

const def = (kind: OutcomeButton['kind']): OutcomeButton => ({
  key: kind, kind, label: kind, color: '#000', reasons: [], requires: { lpr: false, reason: false, callbackAt: false, contact: false, agreement: false, fields: [] },
});
const args = (d: OutcomeButton, callbackV2: boolean, draft: SheetDraft = { ...EMPTY_DRAFT, callbackAt: MON + 1000, callbackPrecision: 'day', reasonCode: 'think' }) => ({
  opId: 'op', cardId: 'cd', def: d, draft, tappedAt: null, now: MON, online: true, callbackV2,
});

test('запрос: под CALLBACK_V2 перезвон всегда с callbackPrecision (по умолчанию time)', () => {
  assert.equal(buildRequest(args(def('callback'), true)).callbackPrecision, 'day');
  assert.equal(buildRequest(args(def('callback'), true, { ...EMPTY_DRAFT, callbackAt: MON, reasonCode: '' })).callbackPrecision, 'time');
});

test('запрос: без флага поля callbackPrecision нет — прежний контракт; у других итогов его тоже нет', () => {
  const plain: SheetDraft = { ...EMPTY_DRAFT, callbackAt: MON, reasonCode: '' };
  assert.equal('callbackPrecision' in buildRequest(args(def('callback'), false, plain)), false);
  assert.equal('callbackPrecision' in buildRequest(args(def('no_answer'), true)), false);
});

test('конфиг устройства совместим с типом (проверка формы)', () => {
  const cfg: Pick<CallConfig, 'callbackV2' | 'callbackSchedule' | 'callWindowStart'> = { callbackV2: true, callbackSchedule: STEPS, callWindowStart: '09:00' };
  assert.equal(cfg.callbackV2, true);
});
