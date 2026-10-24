// Выбор итога в шторке: «Перезвонить» сразу получает срок по касанию (B4), прочие итоги — пустой срок.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseDraftPatch } from '../../../src/ui/call/outcomeDraft';
import { EMPTY_DRAFT, type CallConfig, type OutcomeButton } from '../../../src/ui/call/types';
import { fromLocal } from '../../../src/ui/call/zoned';
import { CALL, OUTCOMES } from '../board/fixtures';

const TZ = 'Asia/Almaty';
// 2026-10-26 — понедельник, 11:00 местного
const MON = fromLocal('2026-10-26', '11:00', TZ);
const cb = OUTCOMES.find((o) => o.kind === 'callback')!;
const noAnswer = OUTCOMES.find((o) => o.kind === 'no_answer')!;
const cfg = (over: Partial<CallConfig> = {}): CallConfig => ({ ...CALL, callbackSchedule: ['+3d', '+7d'], ...over });
const patchOf = (def: OutcomeButton, config: CallConfig, ...rest: [touches?: number | undefined]) => chooseDraftPatch(def, EMPTY_DRAFT, config, [{ id: 'ph-1' }], rest.length > 0 ? rest[0] : 0, MON);

test('«Перезвонить» с подсказкой: срок выбран сразу, точность по шагу', () => {
  const p = patchOf(cb, cfg())!;
  assert.notEqual(p.callbackAt, null);
  assert.equal(p.callbackAt, fromLocal('2026-10-29', '09:00', TZ));
  assert.equal(p.callbackPrecision, 'day');
  assert.equal(p.outcomeKey, 'callback');
  assert.equal(p.reasonCode, '');
});

test('второе касание берёт второй шаг расписания', () => {
  assert.equal(patchOf(cb, cfg(), 1)!.callbackAt, fromLocal('2026-11-02', '09:00', TZ));
});

test('шаг со временем даёт точность «время»', () => {
  const p = patchOf(cb, cfg({ callbackSchedule: ['+2d@15:30'] }))!;
  assert.equal(p.callbackPrecision, 'time');
  assert.equal(p.callbackAt, fromLocal('2026-10-28', '15:30', TZ));
});

test('нет расписания, нет числа касаний или флага воронки — срок не подставляется', () => {
  assert.equal(patchOf(cb, cfg({ callbackSchedule: null }))!.callbackAt, null);
  assert.equal(patchOf(cb, cfg(), undefined)!.callbackAt, null);
  const off = patchOf(cb, cfg({ callbackV2: false }))!;
  assert.equal(off.callbackAt, null);
  assert.ok(!('callbackPrecision' in off));
});

test('другой итог срок не ставит; тот же итог повторно ничего не меняет', () => {
  assert.equal(patchOf(noAnswer, cfg())!.callbackAt, null);
  assert.equal(chooseDraftPatch(cb, { ...EMPTY_DRAFT, outcomeKey: 'callback' }, cfg(), [], 0, MON), null);
});

test('номер подставляется первый, если ещё не выбран', () => {
  assert.equal(patchOf(noAnswer, cfg())!.phoneId, 'ph-1');
  assert.equal(chooseDraftPatch(noAnswer, { outcomeKey: '', phoneId: 'ph-9' }, cfg(), [{ id: 'ph-1' }], 0, MON)!.phoneId, 'ph-9');
});
