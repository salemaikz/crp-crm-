// Состояние карточки из итога таблицы (дизайн C4d §7.3): вектор на каждую строку таблицы, задержанные,
// update_state с накоплением счётчиков, «Подтвержден» = вектор № 30.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calling, time } from '@crm/core';
import { blankCard, planImportedCard, type PlanInput } from '../../../src/server/domain/import/cardPlan';

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);
const OCC = Date.UTC(2026, 9, 20, 18, 0, 0);

const calendar = time.createWorkCalendar({
  timezone: 'Asia/Almaty',
  workdays: [1, 2, 3, 4, 5],
  workHours: { start: '09:00', end: '18:00' },
  callWindow: { start: '09:00', end: '18:00' },
  holidays: [],
});

const def = (key: string, kind: calling.OutcomeKind): calling.OutcomeDef => ({
  key,
  kind,
  requires: { lpr: false, reason: false, callbackAt: false, contact: false, agreement: false },
  archived: false,
  archivedAt: null,
});

const settings = (maxAttempts = 3, days: number | null = 90): calling.CallingSettings => ({
  outcomes: ['no_answer', 'bad_number', 'callback', 'agreed', 'not_interested', 'not_target', 'do_not_call'].map((k) => def(k, k as calling.OutcomeKind)),
  lprRequiredOnContact: false,
  lprNoRequiresInfo: false,
  callbackPastToleranceMin: 5,
  offlineWindowHours: 72,
  retry: { steps: ['+1h', 'nextWorkday@10:00'], maxAttempts },
  returnDays: { not_interested: days, deal_lost_soft: null },
  skipLimit: 5,
  capIncludes: [],
  noShowCallbackAt: '+1h',
  nextStepTaskAt: '+1h',
  autoNoShowWorkdays: null,
  inboundReplyMinutes: 30,
});

const plan = (kind: string | null, o: Partial<PlanInput> = {}, card = blankCard('c1', 'cl1', 'u1', '')) =>
  planImportedCard({
    card,
    row: { outcomeKey: kind, outcomeKind: kind, lpr: '', target: '', ...(o.row ?? {}) },
    held: false,
    workingPhones: 2,
    settings: settings(),
    calendar,
    occurredAt: OCC,
    now: T0,
    importKey: 'op:row:state',
    ...o,
  });

test('пусто → «новая», звонка нет', () => {
  const p = plan(null);
  assert.equal(p.card.state, 'new');
  assert.equal(p.call, null);
  assert.equal(p.deferred, false);
});

test('no_answer → retry, attempts=1, next_call_at=now; maxAttempts=1 → written_off', () => {
  const p = plan('no_answer');
  assert.deepEqual([p.card.state, p.card.attempts, p.card.nextCallAt, p.card.noAnswerTotal, p.card.callsTotal, p.card.connectsTotal], ['retry', 1, T0, 1, 1, 0]);
  assert.equal(p.call?.outcomeKind, 'no_answer');
  assert.equal(p.call?.occurredAt, OCC);
  const w = plan('no_answer', { settings: settings(1) });
  assert.deepEqual([w.card.state, w.card.closeReasonCode, w.card.nextCallAt, w.effects.closeTasks], ['written_off', 'no_answer_limit', null, 'all']);
});

test('bad_number: один рабочий номер → нерабочий и written_off; несколько → retry и замечание', () => {
  const one = plan('bad_number', { workingPhones: 1 });
  assert.deepEqual([one.card.state, one.card.closeReasonCode, one.effects.singlePhoneNotWorking], ['written_off', 'no_working_phone', true]);
  const many = plan('bad_number', { workingPhones: 3 });
  assert.deepEqual([many.card.state, many.card.nextCallAt, many.effects.singlePhoneNotWorking, many.effects.flags], ['retry', T0, false, ['bad_number_ambiguous']]);
});

test('callback → callback сейчас, attempts=0, задача-перезвон, дозвон засчитан', () => {
  const p = plan('callback');
  assert.deepEqual([p.card.state, p.card.attempts, p.card.nextCallAt, p.effects.callbackTask, p.card.connectsTotal], ['callback', 0, T0, true, 1]);
  assert.equal(p.card.firstConnectAt, OCC);
});

test('agreed без записи = вектор № 30: callback сейчас и задача «Уточнить договорённость»', () => {
  const p = plan('agreed');
  assert.deepEqual([p.card.state, p.card.nextCallAt, p.effects.clarifyTask, p.effects.callbackTask, p.call?.outcomeKind], ['callback', T0, true, false, 'agreed']);
  assert.equal(p.card.lastOutcomeCode, 'agreed');
});

test('not_interested: срок возврата; без возврата — null', () => {
  const p = plan('not_interested');
  assert.deepEqual([p.card.state, p.card.returnAt, p.card.closedAt, p.effects.closeTasks], ['not_interested', OCC + 90 * 86_400_000, OCC, 'all']);
  assert.equal(plan('not_interested', { settings: settings(3, null) }).card.returnAt, null);
});

test('not_target: is_target=no, закрыта', () => {
  const p = plan('not_target');
  assert.deepEqual([p.card.state, p.card.isTarget, p.card.closedAt], ['not_target', 'no', OCC]);
});

test('do_not_call: закрыта и рабочие номера идут в стоп-лист', () => {
  const p = plan('do_not_call');
  assert.deepEqual([p.card.state, p.effects.stopListAllWorking, p.effects.closeTasks], ['do_not_call', true, 'all']);
});

test('ЛПР и «Целевой»: пусто не равно «нет»; «Не целевой» без итога not_target не ставится', () => {
  const none = plan(null, { row: { outcomeKey: null, outcomeKind: null, lpr: '', target: '' } });
  assert.equal(none.card.lpr, '');
  const yes = plan(null, { row: { outcomeKey: null, outcomeKind: null, lpr: 'yes', target: 'target' } });
  assert.deepEqual([yes.card.lpr, yes.card.isTarget], ['yes', 'yes']);
  const non = plan('no_answer', { row: { outcomeKey: 'no_answer', outcomeKind: 'no_answer', lpr: 'no', target: 'non_target' } });
  assert.equal(non.card.isTarget, '');
  assert.ok(non.effects.flags.includes('non_target_without_outcome'));
});

test('задержанная строка с рабочим итогом: карточка «новая», звонка нет, итог — только в ленте', () => {
  for (const k of ['no_answer', 'callback', 'agreed']) {
    const p = plan(k, { held: true });
    assert.deepEqual([p.deferred, p.call, p.card.state, p.card.callsTotal], [true, null, 'new', 0], k);
  }
  assert.equal(plan('bad_number', { held: true, workingPhones: 2 }).deferred, true);
});

test('задержанная строка с закрывающим итогом применяется (отказ обязан попасть в стоп-лист)', () => {
  for (const [k, st] of [['do_not_call', 'do_not_call'], ['not_interested', 'not_interested'], ['not_target', 'not_target']] as const) {
    const p = plan(k, { held: true });
    assert.deepEqual([p.deferred, p.card.state], [false, st], k);
  }
  assert.equal(plan('bad_number', { held: true, workingPhones: 1 }).card.state, 'written_off');
  assert.equal(plan('no_answer', { held: true, settings: settings(1) }).card.state, 'written_off');
});

test('update_state: счётчики накапливаются, выход из callback закрывает проекцию', () => {
  const first = plan('no_answer');
  const second = plan('callback', {}, first.card);
  assert.deepEqual([second.card.callsTotal, second.card.noAnswerTotal, second.card.connectsTotal, second.card.state], [2, 1, 1, 'callback']);
  const third = plan('no_answer', {}, second.card);
  assert.equal(third.effects.closeTasks, 'callback');
  assert.equal(third.card.attempts, 1);
  const again = plan('no_answer', {}, third.card);
  assert.equal(again.card.attempts, 2);
});

test('итог неприменим из текущего состояния: звонок фактом (stale), состояние не меняется', () => {
  const closed = plan('not_interested').card;
  const p = plan('callback', {}, closed);
  assert.deepEqual([p.call?.applied, p.call?.factReason, p.card.state, p.card.callsTotal], ['fact_only', 'stale', 'not_interested', 2]);
  assert.ok(p.effects.flags.includes('outcome_stale'));
  assert.equal(p.effects.callbackTask, false);
});

test('неизвестный вид итога = без итога', () => {
  const p = planImportedCard({ ...({} as PlanInput), card: blankCard('c', 'cl', 'u', ''), row: { outcomeKey: 'x', outcomeKind: 'weird', lpr: '', target: '' }, held: false, workingPhones: 1, settings: settings(), calendar, occurredAt: OCC, now: T0, importKey: 'k' });
  assert.equal(p.call, null);
});
