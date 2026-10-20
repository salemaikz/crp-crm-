// Правила досок (B8): чего не хватает этапу, «залежалась», решение о переносе, ответы маршрута, итоги обзвона.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMoveResponse, decideMove } from '../../../src/app/(mgr)/deals/moveRules';
import { dropKinds } from '../../../src/app/(mgr)/deals/calling/dropRules';
import { missingFor, staleDaysOf } from '../../../src/server/domain/deals/boardRules';
import { parseCursor } from '../../../src/server/domain/deals/board';
import { parseBoardPipelines } from '../../../src/server/domain/deals/boardDeps';
import type { BoardStage, DealsBoard } from '../../../src/server/domain/deals/boardTypes';

const req = (o: Partial<{ fields: string[]; booking: boolean; attendance: boolean; nextTask: boolean }> = {}) => ({
  fields: [] as string[], booking: false, attendance: false, nextTask: false, amount: false, serviceType: false, reason: false, ...o,
});
const facts = (o: Partial<{ hasBooking: boolean; hasAttendance: boolean; hasNextTask: boolean; filled: string[] }> = {}) => ({
  hasBooking: false, hasAttendance: false, hasNextTask: false, ...o, filled: new Set(o.filled ?? []),
});

test('missingFor: порядок кодов стабилен, закрытые этапы не считаются', () => {
  const stage = { kind: 'open' as const, requires: req({ booking: true, attendance: true, nextTask: true, fields: ['a', 'b'] }) };
  assert.deepEqual(missingFor(stage, facts({ filled: ['a'] })), ['booking', 'attendance', 'next_step', 'field:b']);
  assert.deepEqual(missingFor(stage, facts({ hasBooking: true, hasAttendance: true, hasNextTask: true, filled: ['a', 'b'] })), []);
  assert.deepEqual(missingFor({ kind: 'won', requires: req({ booking: true }) }, facts()), []);
  assert.deepEqual(missingFor({ kind: 'lost', requires: req({ booking: true }) }, facts()), []);
});

test('staleDaysOf: полные сутки не меньше порога; закрытая и без порога — null', () => {
  const D = 86_400_000;
  const open = { status: 'open' as const, stageChangedAt: 10 * D };
  assert.equal(staleDaysOf(open, { staleDays: 3 }, 13 * D), 3);
  assert.equal(staleDaysOf(open, { staleDays: 3 }, 13 * D - 1), null);
  assert.equal(staleDaysOf(open, { staleDays: null }, 99 * D), null);
  assert.equal(staleDaysOf(open, undefined, 99 * D), null);
  assert.equal(staleDaysOf({ ...open, status: 'won' }, { staleDays: 1 }, 99 * D), null);
});

test('parseCursor: формат «время:id», мусор — ошибка', () => {
  assert.deepEqual(parseCursor('123:dl-1'), { at: 123, id: 'dl-1' });
  assert.equal(parseCursor(null), null);
  assert.throws(() => parseCursor('abc'));
  assert.throws(() => parseCursor("1:x'; DROP"));
});

test('parseBoardPipelines: архивные воронки и этапы отброшены, этапы по порядку', () => {
  const stage = (key: string, order: number, extra: object = {}) => ({ key, label: { ru: key }, kind: 'open', order, requires: req(), staleDays: null, auto: null, ...extra });
  const out = parseBoardPipelines([
    { key: 'p', label: { ru: 'П' }, createDealOn: 'manual', stages: [stage('b', 20), stage('a', 10), stage('x', 5, { archived: true })] },
    { key: 'old', label: { ru: 'О' }, createDealOn: 'manual', archived: true, stages: [] },
  ]);
  assert.deepEqual(out.map((p) => [p.key, p.stages.map((s) => s.key)]), [['p', ['a', 'b']]]);
});

const stages: BoardStage[] = [
  { key: 'n', label: 'n', kind: 'open', order: 10, staleDays: null },
  { key: 'o', label: 'o', kind: 'open', order: 20, staleDays: null },
  { key: 'c', label: 'c', kind: 'open', order: 30, staleDays: null },
  { key: 'won', label: 'w', kind: 'won', order: 90, staleDays: null },
  { key: 'lost', label: 'l', kind: 'lost', order: 99, staleDays: null },
];
const can = (o: Partial<DealsBoard['can']> = {}): DealsBoard['can'] => ({ edit: true, moveBack: true, purchase: true, lose: true, ...o });
const defs: DealsBoard['fieldDefs'] = [
  { key: 'budget', label: 'Бюджет', type: 'money', options: [], editable: true },
  { key: 'secret', label: 'Скрытое', type: 'text', options: [], editable: false },
];
const ctx = (c = can(), fieldDefs = defs) => ({ stages, can: c, fieldDefs });
const tile = (stageKey: string, missing: Record<string, string[]> = {}) => ({ stageKey, missing: missing as never });

test('decideMove: та же колонка и неизвестный этап — ничего', () => {
  assert.deepEqual(decideMove(ctx(), tile('n'), 'n'), { kind: 'noop' });
  assert.deepEqual(decideMove(ctx(), tile('n'), 'zzz'), { kind: 'noop' });
});

test('decideMove: выигран → покупка, проигран → причина, без прав — блок', () => {
  assert.deepEqual(decideMove(ctx(), tile('c'), 'won'), { kind: 'purchase' });
  assert.deepEqual(decideMove(ctx(), tile('c'), 'lost'), { kind: 'lose' });
  assert.deepEqual(decideMove(ctx(can({ purchase: false })), tile('c'), 'won'), { kind: 'blocked', reason: 'readonly' });
  assert.deepEqual(decideMove(ctx(can({ edit: false })), tile('n'), 'o'), { kind: 'blocked', reason: 'readonly' });
});

test('decideMove: назад без deal.move_back не принимается, с правом — как вперёд', () => {
  assert.deepEqual(decideMove(ctx(can({ moveBack: false })), tile('c'), 'n'), { kind: 'blocked', reason: 'back' });
  assert.deepEqual(decideMove(ctx(), tile('c'), 'n'), { kind: 'instant' });
});

test('decideMove: нет записи или явки — блок; нет шага/поля — панель только с недостающим', () => {
  assert.deepEqual(decideMove(ctx(), tile('n', { o: ['booking', 'next_step'] }), 'o'), { kind: 'blocked', reason: 'booking' });
  assert.deepEqual(decideMove(ctx(), tile('n', { c: ['attendance'] }), 'c'), { kind: 'blocked', reason: 'attendance' });
  assert.deepEqual(decideMove(ctx(), tile('n', { o: ['next_step', 'field:budget'] }), 'o'), { kind: 'panel', nextStep: true, fields: ['budget'] });
  assert.deepEqual(decideMove(ctx(), tile('n', { o: ['field:budget'] }), 'o'), { kind: 'panel', nextStep: false, fields: ['budget'] });
  assert.deepEqual(decideMove(ctx(), tile('n', { o: ['field:secret'] }), 'o'), { kind: 'blocked', reason: 'field_forbidden' });
  assert.deepEqual(decideMove(ctx(), tile('n', { o: [] }), 'o'), { kind: 'instant' });
});

test('classifyMoveResponse: коды B6 §6', () => {
  assert.deepEqual(classifyMoveResponse(200, {}), { kind: 'ok' });
  assert.deepEqual(classifyMoveResponse(409, { error: 'conflict' }), { kind: 'stale' });
  assert.deepEqual(classifyMoveResponse(409, { error: 'conflict', detail: 'next_step_required' }), { kind: 'code', code: 'next_step_required' });
  assert.deepEqual(classifyMoveResponse(400, { error: 'use_purchase' }), { kind: 'code', code: 'use_purchase' });
  assert.deepEqual(classifyMoveResponse(403, null), { kind: 'forbidden' });
  assert.deepEqual(classifyMoveResponse(423, null), { kind: 'readonly' });
  assert.deepEqual(classifyMoveResponse(401, null), { kind: 'login' });
  assert.deepEqual(classifyMoveResponse(502, null), { kind: 'network' });
});

test('dropKinds: перенос = итог; в «new» и в ту же колонку нельзя', () => {
  assert.deepEqual(dropKinds('retry', 'callback'), ['callback']);
  assert.deepEqual(dropKinds('callback', 'retry'), ['no_answer']);
  assert.deepEqual(dropKinds('retry', 'agreed'), ['agreed']);
  assert.deepEqual(dropKinds('agreed', 'closed'), ['not_interested', 'not_target', 'do_not_call']);
  assert.deepEqual(dropKinds('retry', 'new'), []);
  assert.deepEqual(dropKinds('retry', 'retry'), []);
});
