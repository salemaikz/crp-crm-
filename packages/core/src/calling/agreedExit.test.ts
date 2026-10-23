// № 33 (pipeline-v2 §3.3): выход из «Договорились» без звонка. Векторы ядра линии C6.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOutcome } from './applyOutcome.js';
import type { AgreedExitEvent, AppliedResult, CardSnapshot, TransitionInput, TransitionResult } from './spec/types.js';
import { at, SETTINGS_V2, TEST_CALENDAR } from './spec/vectors.js';

const NOW = at('2026-10-28 10:00');

const AGREED: CardSnapshot = {
  id: 'card-1',
  clientId: 'client-1',
  ownerUserId: 'u-op-a',
  actingUserId: null,
  actingUntilDay: '',
  state: 'agreed',
  holdReason: '',
  attempts: 0,
  nextCallAt: null,
  returnAt: null,
  lpr: 'yes',
  isTarget: 'yes',
  lastOutcomeCode: 'agreed',
  lastOutcomeKind: 'agreed',
  lastOutcomeAt: at('2026-10-27 12:00'),
  closeReasonCode: '',
  closedAt: null,
  assignedAt: at('2026-10-20 09:00'),
  touchedInCrm: true,
  callbackReason: '',
  callbackTouches: 0,
  nextCallPrecision: 'time',
  callsTotal: 2,
  connectsTotal: 1,
  noAnswerTotal: 1,
  firstConnectAt: at('2026-10-27 12:00'),
  lastConnectAt: at('2026-10-27 12:00'),
  lastTouchAt: at('2026-10-27 12:00'),
  version: 7,
  phones: [],
};

const ev = (p: Partial<AgreedExitEvent> = {}): AgreedExitEvent => ({
  type: 'agreed_exit',
  opId: 'op-33',
  seenVersion: 7,
  to: 'callback',
  reasonCode: 'think',
  callbackAt: at('2026-10-30 11:00'),
  callbackPrecision: 'time',
  attendance: null,
  facts: { futureBookingIds: [] },
  ...p,
});

const run = (event: AgreedExitEvent, card: CardSnapshot | null = AGREED): TransitionResult =>
  applyOutcome({ card, event, actor: { userId: 'u-op-a', kind: 'user', scope: 'own' }, now: NOW, settings: SETTINGS_V2, calendar: TEST_CALENDAR } satisfies TransitionInput);

const okOf = (r: TransitionResult): AppliedResult => {
  assert.equal(r.status, 'applied', JSON.stringify(r));
  return r as AppliedResult;
};

const CLOSE_STEPS = { op: 'close', sources: ['next_step', 'agreement'] };

test('№ 33 + no_show → callback: задача no_show, значок «нужна перезапись», срок и причина выбраны', () => {
  const r = okOf(run(ev({ attendance: { bookingId: 'bk-1', to: 'no_show', eventKind: 'group', changed: true } })));
  assert.equal(r.card.state, 'callback');
  assert.equal(r.card.nextCallAt, at('2026-10-30 11:00'));
  assert.equal(r.card.callbackReason, 'think');
  assert.equal(r.card.callbackTouches, 1);
  assert.equal(r.card.version, 8);
  assert.deepStrictEqual(r.effects.tasks, [
    CLOSE_STEPS,
    { op: 'create', source: 'no_show', kind: 'call', assignee: { user: 'u-op-a' }, dueAt: at('2026-10-30 11:00'), sourceKey: 'no_show:bk-1' },
  ]);
  assert.deepStrictEqual(r.effects.deals, [{ op: 'set_needs_rebook', bookingId: 'bk-1', value: true }]);
  assert.deepStrictEqual(r.effects.bookings, []);
  assert.deepStrictEqual(r.effects.timeline[0]?.ref, { type: 'card_move', id: 'op-33' });
});

test('№ 33 + attended → callback: сделка advance on_attended, обычная задача перезвона', () => {
  const r = okOf(run(ev({ attendance: { bookingId: 'bk-1', to: 'attended', eventKind: 'individual', changed: true } })));
  assert.equal(r.card.state, 'callback');
  assert.deepStrictEqual(r.effects.deals, [{ op: 'advance', stage: 'on_attended', bookingId: 'bk-1' }]);
  assert.deepStrictEqual(r.effects.tasks[1], { op: 'create', source: 'callback', kind: 'call', assignee: { user: 'u-op-a' }, dueAt: at('2026-10-30 11:00'), sourceKey: 'callback:op-33' });
});

test('№ 33 без явки, будущая запись → отменена с причиной client, значок, задача callback', () => {
  const r = okOf(run(ev({ facts: { futureBookingIds: ['bk-9'] } })));
  assert.deepStrictEqual(r.effects.bookings, [{ op: 'cancel_future', reason: 'client' }]);
  assert.deepStrictEqual(r.effects.deals, [{ op: 'set_needs_rebook', bookingId: 'bk-9', value: true }]);
  assert.equal(r.effects.tasks[1]?.op === 'create' && r.effects.tasks[1].source, 'callback');
});

test('№ 33 без явки и без будущей записи → только перезвон', () => {
  const r = okOf(run(ev()));
  assert.deepStrictEqual(r.effects.bookings, []);
  assert.deepStrictEqual(r.effects.deals, []);
});

test('№ 33 + attended → written_off: lose без advance, будущие записи отменены', () => {
  const r = okOf(run(ev({ to: 'written_off', reasonCode: 'unreachable', callbackAt: null, attendance: { bookingId: 'bk-1', to: 'attended', eventKind: 'group', changed: true } })));
  assert.equal(r.card.state, 'written_off');
  assert.equal(r.card.closeReasonCode, 'unreachable');
  assert.equal(r.card.nextCallAt, null);
  assert.deepStrictEqual(r.effects.deals, [{ op: 'lose_open', reasonGroup: 'deal_lost', reasonCode: 'no_show_unreachable' }]);
  assert.ok(r.effects.deals.every((d) => d.op !== 'advance'));
  assert.deepStrictEqual(r.effects.bookings, [{ op: 'cancel_future', reason: 'client' }]);
  assert.deepStrictEqual(r.effects.tasks, [{ op: 'close', sources: 'all' }]);
});

test('№ 33 → not_interested: return_at, lose_open той же причиной', () => {
  const r = okOf(run(ev({ to: 'not_interested', reasonCode: 'too_expensive', callbackAt: null })));
  assert.equal(r.card.state, 'not_interested');
  assert.equal(r.card.closeReasonCode, 'too_expensive');
  assert.deepStrictEqual(r.effects.deals, [{ op: 'lose_open', reasonGroup: 'not_interested', reasonCode: 'too_expensive' }]);
  assert.deepStrictEqual(r.effects.bookings, [{ op: 'cancel_future', reason: 'client' }]);
});

test('№ 33, запись уже attended (changed: false) → те же эффекты', () => {
  const a = okOf(run(ev({ attendance: { bookingId: 'bk-1', to: 'attended', eventKind: 'group', changed: true } })));
  const b = okOf(run(ev({ attendance: { bookingId: 'bk-1', to: 'attended', eventKind: 'group', changed: false } })));
  assert.deepStrictEqual(b, a);
});

test('№ 33: проверки', () => {
  const rej = (r: TransitionResult) => (r.status === 'rejected' ? [r.error, r.field] : r.status);
  assert.deepStrictEqual(rej(run(ev({ seenVersion: 6 }))), ['version_conflict', null]);
  assert.deepStrictEqual(rej(run(ev(), { ...AGREED, state: 'callback' })), ['invalid_transition', null]);
  assert.deepStrictEqual(rej(run(ev(), null)), ['not_found', null]);
  assert.deepStrictEqual(rej(run(ev({ reasonCode: '' }))), ['reason_required', 'reasonCode']);
  assert.deepStrictEqual(rej(run(ev({ reasonCode: 'no_show_group' }))), ['reason_unknown', 'reasonCode']);
  assert.deepStrictEqual(rej(run(ev({ reasonCode: 'nope' }))), ['reason_unknown', 'reasonCode']);
  assert.deepStrictEqual(rej(run(ev({ callbackAt: null }))), ['callback_at_required', 'callbackAt']);
  assert.deepStrictEqual(rej(run(ev({ callbackAt: at('2026-10-27 10:00') }))), ['callback_in_past', 'callbackAt']);
  assert.deepStrictEqual(rej(run(ev({ to: 'written_off', reasonCode: 'auto_limit', callbackAt: null }))), ['reason_unknown', 'reasonCode']);
  assert.deepStrictEqual(rej(run(ev({ to: 'written_off', reasonCode: '', callbackAt: null }))), ['reason_required', 'reasonCode']);
});

test('№ 33: точность «день» — сегодняшний срок допустим', () => {
  const r = okOf(run(ev({ callbackAt: at('2026-10-28 09:00'), callbackPrecision: 'day' })));
  assert.equal(r.card.nextCallPrecision, 'day');
});

// ---------- № 31 после № 33 ----------

const correct = (card: CardSnapshot, hasOpenNoShowTask: boolean): TransitionResult =>
  applyOutcome({
    card,
    event: { type: 'attendance_corrected', opId: 'op-31', bookingId: 'bk-1', noShowMarkedAt: NOW, facts: { hasNextFutureBooking: true, hasOpenNoShowTask } },
    actor: { userId: 'u-op-a', kind: 'user', scope: 'own' },
    now: NOW + 3_600_000,
    settings: SETTINGS_V2,
    calendar: TEST_CALENDAR,
  });

test('№ 31 после № 33 + no_show → agreed', () => {
  const after = okOf(run(ev({ attendance: { bookingId: 'bk-1', to: 'no_show', eventKind: 'group', changed: true } }))).card;
  const r = correct(after, true);
  assert.equal(r.status, 'applied');
  if (r.status === 'applied') assert.equal(r.card.state, 'agreed');
});

test('№ 31 после № 33 без неявки → stale', () => {
  const after = okOf(run(ev())).card;
  assert.deepStrictEqual(correct(after, false), { status: 'rejected', error: 'stale', field: null });
});
